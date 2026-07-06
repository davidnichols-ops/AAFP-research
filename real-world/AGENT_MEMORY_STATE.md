# Agent Memory & State Management for AAFP

**Author:** Devin (research synthesis)
**Date:** 2026-07-05
**Status:** Reference design — Phase 4 (World Perception Layer) companion
**Depends on:** `SESSION_AFFINITY_DESIGN.md` (P2.7 SessionManager),
`STREAMING_RPC_DESIGN.md` (P2.8), `AGENT_RECORD_EXTENSIONS.md`,
`LLM_AGENT_INTEGRATION.md`, `FEDERATION_TRUST.md`,
`PERFORMANCE_SCALABILITY.md`

---

## Executive Summary

An AAFP agent is not a stateless function. Even the simplest wrapper around an
LLM must remember which session it is in, what it has already said, which
tool calls are pending, and how many tokens it has spent this hour. As agents
grow into long-running orchestrators that move between hosts, delegate to
peers, and accumulate reputation, the question of *what state lives where,
for how long, and in what format* becomes a first-class architectural concern.

This document specifies a complete state and memory architecture for AAFP
agents. It defines four state categories (ephemeral, session, persistent,
shared), maps each to concrete backends (in-memory, SQLite, Redis,
PostgreSQL, IPFS), mandates CBOR as the single serialization format for all
persistent state, and details session management, conversation memory,
context-window advertisement, memory budgets, garbage collection, state
migration when an agent relocates, and synchronization for multi-instance
agents. It closes with a concrete architecture for a stateful LLM agent that
fits in under 100 MB of state while supporting unbounded conversation
history.

**Key conclusions:**

1. **State must be categorized before it is stored.** Mixing ephemeral
   request-scoped buffers with persistent identity in the same HashMap is the
   single most common cause of memory leaks and restart bugs in agent
   runtimes. AAFP mandates a four-tier classification enforced by the
   `AgentStateStore` trait.
2. **CBOR everywhere for persistent state.** JSON is for humans and logs;
   CBOR (per RFC-0003) is for anything that survives a process boundary.
   Integer-keyed CBOR maps keep agent records, session snapshots, and
   attestations compact and schema-evolvable.
3. **The DHT is the shared tier, not the session tier.** Agent records,
   capability advertisements, and attestations belong in the DHT because
   they are public, replicated, and TTL-bounded. Conversation memory and
   pending approvals do *not* — they are private, large, and per-session.
4. **Memory is budgeted, not unbounded.** Every agent advertises a
   `state_budget_bytes` in its record. The runtime enforces it via
   tiered eviction: ephemeral first, then session, then long-term memory
   compaction. Target: **< 100 MB per agent**.
5. **Migration is a snapshot, not a live handoff.** When an agent moves
   hosts, it serializes its persistent state to a CBOR bundle, transfers it
   via an AAFP capability call, and rehydrates on the new host. Session state
   is *not* migrated — clients reconnect and resume by session ID.

---

## 1. Why State Management Is a First-Class Concern

### 1.1 The Failure Modes

Agent runtimes that treat state as an afterthought exhibit a predictable set
of failures:

| Failure | Cause | AAFP mitigation |
|---------|-------|-----------------|
| Restart amnesia | Identity/keypair not persisted | `AgentIdentity` in persistent store (§4.1) |
| Session loss on reconnect | Session state in process memory only | `SessionManager` with pluggable `SessionStore` (§3) |
| Unbounded memory growth | Conversation log never trimmed | Memory budget + episodic compaction (§9, §11) |
| DHT record staleness | No republish / TTL discipline | Republish interval < TTL/2 (§5.4) |
| Cross-instance drift | Two replicas mutate shared state without coordination | CRDT counters + leader-elected writes (§8) |
| Migration data loss | State scattered across ad-hoc files | Single CBOR state bundle (§7) |
| Context overflow | Agent doesn't know its own window | `context_window` in capability metadata (§10) |

### 1.2 The AAFP Principle: Categorize, Then Store

Before choosing a backend, an agent runtime must classify each piece of
state into one of four categories. The category dictates the backend, the
serialization, the replication strategy, and the garbage-collection policy.

```
┌─────────────────────────────────────────────────────────────┐
│                    Agent State Hierarchy                     │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  EPHEMERAL    ── in-process, dies with the request           │
│      │                                                       │
│  SESSION      ── per-connection, dies with session (or TTL)  │
│      │                                                       │
│  PERSISTENT   ── survives restart, owned by one agent        │
│      │                                                       │
│  SHARED       ── replicated across the network (DHT/IPFS)    │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Agent State Categories

### 2.1 Ephemeral State (In-Memory)

State whose lifetime is bounded by a single request or stream. It lives in
process memory and is never serialized. If the process crashes, this state
is correctly lost — it was transient by definition.

**Examples:**

- The current `TokenChunk` being assembled from a stream before emission.
- A partial CBOR decode buffer for an incoming request frame.
- A `CancellationToken` for the in-flight RPC.
- The live `QuicConnection` and bi-stream handles for an active call.
- Intermediate reasoning scratch space (e.g., a chain-of-thought buffer
  that is discarded once the final answer is produced).

**Storage:** Process heap / `tokio::task` locals. No backend trait
implementation. The runtime MUST NOT hold references to ephemeral state
across `await` points that could outlive the request.

**Sizing:** Bounded by `max_request_bytes` (default 1 MB) plus a small
fixed overhead per concurrent stream. With 1000 concurrent streams, ephemeral
state is ~1 GB worst case — this is why `max_concurrent_streams` is
configurable per agent (§11).

### 2.2 Session State (Per-Connection)

State whose lifetime is bounded by a logical session — a sequence of
related requests between a client agent and a server agent, identified by a
`SessionId` (32-byte random, per `SIMPLE_API_V2_DESIGN.md` §5). Session
state survives request boundaries but not (necessarily) process restarts,
depending on the configured `SessionStore` backend.

**Examples:**

- Conversation context for a multi-turn chat (the message history for this
  session, up to the context window).
- Active streaming RPCs outstanding on this session (for cancellation and
  backpressure accounting).
- Pending approvals: tool calls that require user confirmation before
  execution, held in a queue keyed by session.
- Per-session rate-limit counters (tokens consumed this minute by this
  session).
- The negotiated capability set: which capabilities the client is
  authorized to invoke on this session (UCAN scope).

**Storage:** `SessionManager` backed by a `SessionStore` trait
(§3). Default backend is in-memory; production deployments use SQLite or
Redis for cross-restart persistence.

**Sizing:** Dominated by conversation context. A 128k-token context window
is ~500 KB of UTF-8 text. With 100 active sessions, session state is ~50 MB.
This is the largest variable component of an agent's memory budget (§11).

### 2.3 Persistent State (Survives Restart)

State owned by a single agent that must survive process restarts, host
migrations, and crashes. It is private to the agent — not replicated to the
network unless the agent explicitly publishes it.

**Examples:**

- **Agent identity:** the `AgentKeypair` (ML-DSA-65 private key) and the
  derived `AgentId`. Without this, the agent cannot authenticate on restart.
- **Capability registry:** the local list of capabilities this agent
  serves, with handler bindings and per-capability config.
- **Trust scores:** this agent's view of other agents' trustworthiness,
  accumulated from observed interactions (distinct from *published*
  reputation, which is shared/attested).
- **Long-term memory:** summarized conversation history, user preferences,
  learned facts — the agent's "memory of the world."
- **Reputation ledger:** attestations this agent has *issued* about others
  (signed, may be published later).
- **Cost & usage counters:** cumulative tokens spent, USD consumed, per
  capability — for budget enforcement and reporting.
- **Pending tasks:** durable task queue for background work (e.g., a
  scheduled web crawl).

**Storage:** `PersistentStore` trait, default SQLite (single file per agent,
portable across hosts). High-scale deployments use PostgreSQL. The keypair
is stored encrypted at rest (§4.1).

**Sizing:** Dominated by long-term memory. With episodic compaction (§9.3),
a year of conversations compresses to ~10–30 MB. Identity, registry, and
counters are < 1 MB combined. Target persistent footprint: < 50 MB.

### 2.4 Shared State (Across Agents)

State that is replicated across the network and accessible to multiple
agents. This is the *public* face of an agent — what the network knows
about it.

**Examples:**

- **Agent records:** the signed `AgentRecord` published to the DHT,
  advertising capabilities, endpoints, extensions (per
  `AGENT_RECORD_EXTENSIONS.md`).
- **Attestations:** third-party-signed statements about an agent's
  performance, reputation, or trustworthiness, stored alongside the record
  (§7 of `AGENT_RECORD_EXTENSIONS.md`).
- **Capability advertisements:** the capability graph edges
  (`Specializes`, `Composes`) that let discovery route `code-generation`
  queries to `text-generation` providers.
- **Reputation references:** the `attestation_refs` in the
  `aafp.reputation.v1` extension — pointers, not the attestations
  themselves (which may live in IPFS for large payloads).
- **Shared blobs:** large shared artifacts (model weights, datasets,
  compiled tools) referenced by CID and stored in IPFS, with the CID
  published in the DHT.

**Storage:** AAFP DHT (Kademlia) for records and attestations; IPFS for
large content-addressed blobs. The DHT provides replication, TTL, and
eventual consistency; IPFS provides content addressing and deduplication.

**Sizing:** The DHT record itself is small (< 4 KB target, per
`AGENT_RECORD_EXTENSIONS.md` §3). Attestations are separate records, each
< 1 KB. Large shared blobs live in IPFS and are referenced by CID — they
do not count against the agent's local state budget.

### 2.5 Category Summary Table

| Category | Lifetime | Backend (default) | Serialized? | Replicated? | GC trigger |
|----------|----------|-------------------|-------------|-------------|------------|
| Ephemeral | Request | Process heap | No | No | Request end |
| Session | Session/TTL | In-memory / SQLite / Redis | Yes (CBOR) | No | Idle timeout |
| Persistent | Indefinite | SQLite / PostgreSQL | Yes (CBOR) | No (local) | Manual / budget |
| Shared | TTL (DHT) | DHT / IPFS | Yes (CBOR) | Yes | TTL expiry |

---

## 3. Session State (P2.7 SessionManager)

### 3.1 The SessionManager

Per `SESSION_AFFINITY_DESIGN.md` §4, the `SessionManager` is the component
that owns session-scoped state on the server side. It is injected into the
`ServeBuilder` via `with_session_manager()`.

```rust
pub struct SessionManager {
    store: Arc<dyn SessionStore>,
    config: SessionConfig,
}

pub struct SessionConfig {
    pub idle_timeout: Duration,       // default 30 min
    pub max_sessions: usize,          // default 10_000
    pub max_state_bytes_per_session: usize,  // default 2 MB
    pub republish_interval: Duration, // for Redis-backed heartbeat
}

pub struct SessionState {
    pub session_id: SessionId,        // [u8; 32]
    pub peer_agent_id: AgentId,
    pub created_at: u64,              // unix epoch seconds
    pub last_activity: u64,
    pub custom_data: HashMap<String, Vec<u8>>,  // CBOR-encoded values
    // LLM-specific fields (see §9):
    pub conversation: Vec<Message>,
    pub pending_approvals: Vec<PendingApproval>,
    pub active_streams: Vec<StreamId>,
    pub token_usage: TokenUsage,
}
```

### 3.2 The SessionStore Trait

The `SessionStore` trait abstracts the backend so that the same
`SessionManager` works in-memory for tests, SQLite for single-host
production, and Redis for multi-instance deployments.

```rust
#[async_trait]
pub trait SessionStore: Send + Sync {
    async fn get(&self, id: SessionId) -> Option<SessionState>;
    async fn put(&self, id: SessionId, state: SessionState) -> Result<()>;
    async fn delete(&self, id: SessionId);
    async fn evict_idle(&self, timeout: Duration) -> usize;
    async fn list(&self) -> Vec<SessionId>;  // for diagnostics
}
```

**Implementations:**

| Backend | When to use | Persistence | Multi-instance |
|---------|-------------|-------------|----------------|
| `InMemorySessionStore` | Tests, single-process dev | No | No |
| `SqliteSessionStore` | Single-host production | Yes (file) | No |
| `RedisSessionStore` | Multi-instance, low-latency | Yes (Redis) | Yes |
| `PostgresSessionStore` | Multi-instance, durable, queryable | Yes (DB) | Yes |

### 3.3 Conversation Context

The conversation context is the ordered list of `Message` objects exchanged
in a session. It is the primary input to the LLM on each turn.

```rust
pub struct Message {
    pub role: Role,              // System, User, Assistant, Tool
    pub content: String,
    pub tool_calls: Vec<ToolCall>,   // for Assistant messages
    pub tool_call_id: Option<String>, // for Tool messages
    pub timestamp: u64,
    pub token_count: u32,        // cached for budget enforcement
}

pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}
```

The conversation is stored as part of `SessionState` and serialized to CBOR
when the session is persisted:

```cbor
SessionState = {
    1: bstr .size 32,        // session_id
    2: bstr,                 // peer_agent_id
    3: uint,                 // created_at
    4: uint,                 // last_activity
    5: { *tstr => bstr },    // custom_data (CBOR-encoded values)
    6: [*Message],           // conversation
    7: [*PendingApproval],   // pending_approvals
    8: [*bstr],              // active_streams (StreamIds)
    9: TokenUsage,           // token_usage
}
```

### 3.4 Active Streams

Each in-flight streaming RPC is tracked so that the agent can:

- **Cancel** all streams when a session is terminated
  (`session_manager.cancel_all(session_id)`).
- **Apply backpressure** by counting active streams against
  `max_concurrent_streams_per_session`.
- **Clean up** on client disconnect (QUIC stream reset triggers
  `CancellationToken`, which removes the `StreamId` from the session).

```rust
pub struct StreamRegistration {
    pub stream_id: StreamId,
    pub capability: String,
    pub started_at: u64,
    pub cancel: CancellationToken,
}
```

### 3.5 Pending Approvals

When an agent wants to invoke a tool with side effects (e.g., send an email,
execute a shell command, spend money), it may require explicit user
approval. The approval request is enqueued in the session state and surfaced
to the client via a dedicated RPC capability (`approval.request` /
`approval.respond`).

```rust
pub struct PendingApproval {
    pub approval_id: [u8; 16],   // UUID
    pub capability: String,      // e.g., "shell.exec"
    pub params: Params,          // the proposed call
    pub rationale: String,       // why the agent wants this
    pub risk_score: u8,          // 0-100, agent's self-assessment
    pub created_at: u64,
    pub deadline: u64,           // auto-deny after this
    pub status: ApprovalStatus,  // Pending, Approved, Denied, Expired
}

pub enum ApprovalStatus {
    Pending,
    Approved,
    Denied,
    Expired,
}
```

The `SessionManager` runs a background task that expires pending approvals
past their deadline (default 5 minutes), transitioning them to `Expired`
and emitting an event so the agent can continue with a fallback plan.

### 3.6 Session Lifecycle

```
   Client                          Server (SessionManager)
     │                                    │
     │── RPC w/ session_id ──────────────▶│ get_or_create(session_id)
     │                                    │   ├─ exists? load from store
     │                                    │   └─ new? create, put to store
     │                                    │
     │◀── response (streaming) ───────────│ update last_activity
     │                                    │ append to conversation
     │                                    │
     │── ... more turns ... ─────────────▶│
     │                                    │
     │── disconnect / session_end ───────▶│ mark idle (TTL starts)
     │                                    │
     │                                    │ (after idle_timeout)
     │                                    │ evict_idle() removes session
     │                                    │   ├─ in-memory: dropped
     │                                    │   ├─ SQLite: row deleted
     │                                    │   └─ Redis: key expires
```

---

## 4. Persistent State

### 4.1 Agent Identity

The most critical persistent state is the agent's identity: the
`AgentKeypair`. Loss of the private key means the agent can never
authenticate again — its `AgentId` is permanently orphaned.

```rust
pub struct AgentIdentity {
    pub agent_id: AgentId,          // derived from public key
    pub keypair: AgentKeypair,      // ML-DSA-65
    pub created_at: u64,
    pub display_name: Option<String>,
    pub parent_agent_id: Option<AgentId>,  // for delegated agents
}

pub struct EncryptedIdentity {
    pub ciphertext: Vec<u8>,        // XChaCha20-Poly1305
    pub nonce: [u8; 24],
    pub salt: [u8; 16],             // for KDF
    pub kdf_ops: u32,               // Argon2id iterations
}
```

**Storage:** The keypair is encrypted at rest with a passphrase-derived key
(Argon2id + XChaCha20-Poly1305). On startup, the agent process either:

1. **Interactive:** prompts the operator for the passphrase, or
2. **Unattended:** reads the passphrase from a secret manager (Vault, AWS
   Secrets Manager, environment variable in a sealed deployment).

The encrypted identity blob is stored in the `PersistentStore` under the
key `"identity"`. It is the *first* thing loaded on boot — nothing else can
function without it.

### 4.2 Capability Registry

The local capability registry maps capability names to handler bindings and
per-capability configuration. This is what the agent serves from; it is the
source of truth for the `capabilities` field in the `AgentRecord` published
to the DHT.

```rust
pub struct CapabilityRegistry {
    pub entries: Vec<CapabilityEntry>,
}

pub struct CapabilityEntry {
    pub name: String,               // "text-generation"
    pub handler: HandlerRef,        // function pointer / plugin path
    pub semantic: Option<SemanticCapabilityData>,
    pub cost_model: Option<CostModel>,
    pub perf_profile: Option<PerformanceProfile>,
    pub enabled: bool,
    pub rate_limit: Option<RateLimit>,
}
```

The registry is persisted so that a restart restores the exact capability
set without re-reading config files. Changes to the registry trigger a DHT
republish (§5.4).

### 4.3 Trust Scores (Local View)

Each agent maintains a private, local trust score for every peer it has
interacted with. This is distinct from *published* reputation
(§5.3) — it is the agent's own experience, never shared unless explicitly
attested.

```rust
pub struct TrustLedger {
    pub scores: HashMap<AgentId, TrustEntry>,
}

pub struct TrustEntry {
    pub agent_id: AgentId,
    pub score: i16,                 // -1000 to +1000
    pub interactions: u32,
    pub successes: u32,
    pub failures: u32,
    pub last_interaction: u64,
    pub notes: Option<String>,
}
```

Trust scores decay over time (exponential decay with a half-life of 30
days) so that stale observations matter less than recent ones. The decay
runs as part of the daily maintenance task (§12).

### 4.4 Long-Term Memory

Long-term memory is the agent's compressed, queryable knowledge base —
summaries of past conversations, user preferences, learned facts. It is
structured as a vector database for semantic retrieval plus an episodic
event log for chronological recall (§9).

### 4.5 Cost & Usage Counters

```rust
pub struct UsageCounters {
    pub total_tokens_in: u64,
    pub total_tokens_out: u64,
    pub total_cost_micro_usd: u64,
    pub per_capability: HashMap<String, CapabilityUsage>,
    pub per_day: HashMap<u64, DailyUsage>,   // keyed by day
    pub budget_limit_micro_usd: Option<u64>,
}
```

These counters are persisted on every call (write-behind buffered, flushed
every 10 seconds or 100 calls, whichever comes first). They drive budget
enforcement: when `total_cost_micro_usd` exceeds `budget_limit_micro_usd`,
the agent refuses new chargeable calls and returns a `BudgetExceeded` error.

### 4.6 PersistentStore Trait

```rust
#[async_trait]
pub trait PersistentStore: Send + Sync {
    async fn get(&self, key: &str) -> Option<Vec<u8>>;   // CBOR blob
    async fn put(&self, key: &str, value: Vec<u8>) -> Result<()>;
    async fn delete(&self, key: &str);
    async fn keys(&self, prefix: &str) -> Vec<String>;
    async fn checkpoint(&self) -> Result<()>;  // fsync / WAL checkpoint
}
```

Keys are namespaced: `"identity"`, `"registry"`, `"trust"`, `"memory.long"`,
`"memory.episodic"`, `"usage"`, `"tasks"`.

---

## 5. Shared State via DHT

### 5.1 Agent Records in the DHT

The `AgentRecord` (per `AGENT_RECORD_EXTENSIONS.md`) is the canonical shared
state. It is signed by the agent's keypair, published to the DHT under the
key `AgentId`, and replicated across the network. Its core fields:

```cbor
AgentRecord = {
    1: tstr,            // name
    2: [*CapabilityDescriptor],  // capabilities
    3: [*Endpoint],     // endpoints
    4: bstr,            // public_key
    5: uint,            // version
    6: uint,            // expires_at
    7: bstr,            // signature
    ? 11: { *tstr => Extension },  // extensions (cost, perf, semantic, ...)
}
```

The record is the *shared* projection of the agent — it contains only what
the network needs for discovery and routing. Private state (sessions,
long-term memory, trust ledger) is never in the record.

### 5.2 Attestations

Attestations are third-party-signed statements about an agent. They are
stored as separate records in the DHT, keyed by `SHA-256(attestation_bytes)`,
and referenced from the `aafp.reputation.v1` extension.

```cbor
Attestation = {
    1: bstr,            // subject_agent_id
    2: bstr,            // attester_agent_id
    3: tstr,            // claim_type ("performance", "reputation", "uptime")
    4: any,             // claim_value (CBOR, type-specific)
    5: uint,            // issued_at
    6: uint,            // expires_at
    7: bstr,            // attester_signature
}
```

Attestations are the *trusted* counterpart to self-reported metrics. An
agent's `aafp.perf.v1` extension claims "p99 = 200ms"; an attestation from
a trusted observer confirms "I measured p99 = 210ms over 1000 calls." The
routing layer weights attested metrics higher than self-reported ones (per
`FEDERATION_TRUST.md`).

### 5.3 Capability Advertisements

Capability advertisements are embedded in the `AgentRecord` (key 2) but
also surface in the semantic capability graph (per
`SEMANTIC_CAPABILITY_GRAPHS.md`). The graph edges (`Specializes`,
`Composes`, `Requires`) are themselves shared state — they let the
discovery layer route a `text-generation` query to a `code-generation`
provider without the client knowing the specialization relationship
ahead of time.

### 5.4 DHT Republish and TTL

DHT records have a TTL (key 6, `expires_at`). The agent MUST republish
before the record expires, or it becomes undiscoverable. The convention:

```
republish_interval = min(TTL / 2, 1 hour)
```

For a 24-hour TTL, the agent republishes every 12 hours (or on any change
to the record). Republish is a background task that:

1. Rebuilds the record from the local capability registry + extensions.
2. Signs it with the current keypair.
3. Publishes to the DHT via `dht.put(agent_id, record)`.
4. Logs the republish event for observability.

If republish fails (network partition), the agent retries with exponential
backoff and emits a `DhtRepublishFailed` alert if it fails for > 3
consecutive attempts — this means the agent is at risk of becoming
undiscoverable before its TTL expires.

### 5.5 IPFS for Large Shared Blobs

Some shared state is too large for the DHT (model weights, datasets,
compiled tool binaries). These are stored in IPFS and referenced by CID in
the agent record or in a dedicated extension:

```cbor
// "aafp.blob.v1" extension
{
    1: 1,                          // version
    2: {
        1: "QmXYZ...",             // CID
        2: "model-weights",        // label
        3: 1073741824,             // size_bytes
        4: "sha256:...",           // integrity hash
    }
}
```

The DHT record stays small (< 4 KB); the blob is fetched on demand from
IPFS and cached locally. Cached blobs count against the persistent state
budget unless stored in a separate blob cache directory with its own
eviction policy.

---

## 6. Memory Backends

### 6.1 Backend Selection Matrix

| Backend | Tier | Latency | Persistence | Multi-instance | Use case |
|---------|------|---------|-------------|----------------|----------|
| In-memory | Ephemeral, Session | ~100 ns | No | No | Tests, dev, hot cache |
| SQLite | Session, Persistent | ~10 µs | Yes (file) | No | Single-host production |
| Redis | Session | ~500 µs | Yes (RAM+disk) | Yes | Multi-instance sessions |
| PostgreSQL | Persistent, Shared (app-level) | ~1 ms | Yes (disk) | Yes | Durable, queryable state |
| IPFS | Shared (blobs) | Variable | Yes (pinned) | Yes (content-addressed) | Large shared artifacts |
| Vector DB (e.g., Qdrant) | Long-term memory | ~5 ms | Yes | Yes | Semantic retrieval |

### 6.2 In-Memory

The default for ephemeral state and the simplest session store. Implemented
as `HashMap`/`DashMap` behind the relevant trait. No persistence; on
restart, all in-memory state is lost. Suitable for:

- Ephemeral request buffers (always).
- Session state in dev/test (acceptable).
- Session state in production *only if* session loss on restart is
  tolerable (e.g., stateless LLM wrappers where the client resends context).

### 6.3 SQLite

The default `PersistentStore` and the recommended `SessionStore` for
single-host production. A single file (`agent-state.db`) holds all
persistent state in a key-value table, plus separate tables for sessions
and episodic memory.

```sql
CREATE TABLE kv_state (
    key   TEXT PRIMARY KEY,
    value BLOB NOT NULL,           -- CBOR-encoded
    updated_at INTEGER NOT NULL
);

CREATE TABLE sessions (
    session_id  BLOB PRIMARY KEY,
    state       BLOB NOT NULL,     -- CBOR-encoded SessionState
    last_activity INTEGER NOT NULL
);
CREATE INDEX idx_sessions_activity ON sessions(last_activity);

CREATE TABLE episodic_events (
    event_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  BLOB,
    timestamp   INTEGER NOT NULL,
    event_type  TEXT NOT NULL,
    payload     BLOB NOT NULL       -- CBOR
);
CREATE INDEX idx_episodic_ts ON episodic_events(timestamp);
```

**Advantages:** zero-config, single-file portability (copy the file to
migrate hosts), ACID transactions, WAL mode for concurrent reads. The file
is the unit of migration (§7).

### 6.4 Redis

The recommended `SessionStore` for multi-instance deployments where any
instance should be able to serve any session (session affinity is at the
*session ID* level, not the *host* level). Redis provides:

- Sub-millisecond reads for session state.
- Automatic TTL expiry (set `EXPIRE` on session keys = idle_timeout).
- Pub/sub for session invalidation across instances (§8.3).
- Atomic operations for counters (rate limits, token usage).

```
SESSION:{session_id}  → CBOR(SessionState)   TTL 1800
USAGE:{agent_id}      → hash of counters
RATE:{agent_id}:{min} → counter               TTL 60
```

### 6.5 PostgreSQL

For agents with large persistent state that needs relational querying —
e.g., an agent that maintains a structured knowledge base, joins across
sessions for analytics, or serves as a federation hub tracking thousands
of peer agents. PostgreSQL is overkill for a single LLM wrapper but
appropriate for orchestrator agents and federation relays.

### 6.6 IPFS

For content-addressed shared blobs (§5.5). The agent pins blobs it depends
on and unpins (allowing GC) blobs it no longer needs. IPFS is *not* used
for session or persistent state — it's append-only content-addressed
storage, not a mutable key-value store.

### 6.7 Vector Database (Long-Term Memory)

Long-term semantic memory requires approximate nearest neighbor search
over embeddings. This is a specialized backend (Qdrant, pgvector, LanceDB,
or an in-process library like `usearch`). The vector DB stores:

```rust
pub struct MemoryEntry {
    pub id: [u8; 16],               // UUID
    pub embedding: Vec<f32>,        // 768-d or 1536-d
    pub content: String,            // the summarized text
    pub source_session: SessionId,
    pub timestamp: u64,
    pub importance: u8,             // 0-100, affects retention
    pub tags: Vec<String>,
}
```

For single-host agents, `pgvector` (PostgreSQL extension) or an embedded
LanceDB keeps the stack simple. For multi-instance, a standalone Qdrant
cluster is appropriate.

---

## 7. State Serialization: CBOR

### 7.1 Why CBOR for All Persistent State

AAFP mandates CBOR (RFC 8949) for all state that crosses a process
boundary, per RFC-0003. The reasons:

1. **Compactness.** Integer-keyed CBOR maps are ~40% smaller than the
   equivalent JSON for agent records and session state. This matters for
   DHT storage, Redis memory, and migration bundle size.
2. **Binary fidelity.** `AgentId` (32 bytes), `SessionId` (32 bytes), and
   signatures are `bstr` in CBOR — no base64 encoding overhead, no
   ambiguity about padding.
3. **Schema evolution.** CBOR maps tolerate additional keys gracefully
   (unknown keys are ignored by older readers), enabling backward-compatible
   extension — the same pattern used by `AgentRecord` key 11.
4. **Consistency with the wire.** AAFP RPC already uses CBOR for request/
   response frames. Using CBOR for state means no serialization boundary
   between in-flight data and stored data — a `TokenChunk` streamed over
   RPC is the same CBOR structure appended to the episodic log.

### 7.2 Integer-Keyed Convention

All persistent CBOR structures use integer keys (per
`AGENT_RECORD_EXTENSIONS.md` §2.2) to minimize size and avoid string
interning. A canonical key map is documented per structure (see §3.3 for
`SessionState`, §5.1 for `AgentRecord`).

### 7.3 Canonical CBOR for Signing

Any state that is signed (agent records, attestations) MUST be encoded in
deterministic / canonical CBOR (RFC 8949 §4.2) before signing. This means:

- Map keys sorted by canonical byte order.
- No indefinite-length encodings.
- Minimal-length integers.
- `bstr` for byte strings, not `tstr`.

The signing domain separator (`RECORD_DOMAIN_SEPARATOR`,
`ATTESTATION_DOMAIN_SEPARATOR`) is prepended to the canonical bytes before
the ML-DSA-65 signature, preventing cross-context signature reuse.

### 7.4 Versioning

Every persistent CBOR structure carries a `version: uint` field (key 1 in
most structures). On deserialization, the loader checks the version and
applies a migration function if needed:

```rust
fn migrate_session_state(raw: &[u8]) -> Result<SessionState> {
    let mut v: cbor::Value = cbor::decode(raw)?;
    let version = v.field(1).as_u64()?;
    match version {
        1 => migrate_v1_to_v2(&mut v)?,
        2 => migrate_v2_to_v3(&mut v)?,
        3 => (),  // current
        _ => return Err(unsupported_version),
    }
    cbor::decode::<SessionState>(v)
}
```

---

## 8. State Migration (Agent Relocation)

### 8.1 When Agents Move

An agent may relocate to a new host for several reasons:

- **Operator-initiated:** moving from a laptop to a server, or between
  cloud regions.
- **Load shedding:** a host at capacity offloads an agent to a peer.
- **Failure recovery:** the agent's host died; a standby host takes over
  from a backup.
- **Federation:** an agent migrates from a personal federation to a shared
  one.

### 8.2 The Migration Bundle

Migration is a *snapshot*, not a live handoff. The agent serializes its
persistent state into a single CBOR bundle, transfers it, and rehydrates.

```cbor
MigrationBundle = {
    1: 3,                         // bundle format version
    2: bstr,                      // agent_id
    3: uint,                      // snapshot_timestamp
    4: EncryptedIdentity,         // encrypted keypair
    5: CapabilityRegistry,        // CBOR
    6: TrustLedger,               // CBOR
    7: [*MemoryEntry],            // long-term memory (or CID to IPFS)
    8: UsageCounters,             // CBOR
    9: [*PendingTask],            // durable task queue
    10: bstr,                     // SHA-256 of the above, for integrity
}
```

If the long-term memory is large (> 10 MB), it is stored in IPFS and
referenced by CID in field 7 instead of inlined. The bundle itself stays
small (< 50 MB target).

### 8.3 The Migration Protocol

```
   Old Host                          New Host
      │                                 │
      │  1. agent.migrate(target)       │
      │───── AAFP RPC ─────────────────▶│
      │                                 │  2. verify target identity
      │                                 │  3. allocate storage
      │◀──── ack (ready) ───────────────│
      │                                 │
      │  4. serialize MigrationBundle   │
      │  5. encrypt with target pubkey  │
      │  6. stream bundle via RPC ─────▶│
      │                                 │  7. decrypt, verify hash
      │                                 │  8. load identity (prompt for passphrase)
      │                                 │  9. load registry, trust, memory, usage
      │                                 │ 10. republish AgentRecord to DHT
      │◀──── done ──────────────────────│
      │                                 │
      │  11. stop serving               │
      │  12. delete local state         │
      │  13. emit MigrationComplete     │
```

**Key rules:**

- The bundle is encrypted to the new host's public key (hybrid encryption:
  X25519 ECDH + XChaCha20-Poly1305) so it can transit untrusted networks.
- Session state is *not* migrated. Clients reconnect by `SessionId`; if the
  session is gone, they start a new session (the conversation context is
  lost unless the client retained it — which well-behaved clients do).
- The old host does not delete its state until the new host confirms
  successful rehydration. This prevents data loss if migration fails
  mid-transfer.
- The DHT record is republished from the new host with updated endpoints,
  bumping the record version. Old endpoints become stale and age out via
  TTL.

### 8.4 What Is NOT Migrated

- **Ephemeral state:** gone with the old process.
- **Session state:** clients must re-establish. (Rationale: sessions are
  tied to the connection and the in-flight streams; migrating them
  correctly requires live stream migration, which is out of scope. The
  client-side SDK retries with the session ID and, on failure, starts a
  fresh session.)
- **DHT records:** not migrated — they are *republished* from the new host.
  The DHT handles the update via version bump.
- **IPFS blobs:** not migrated — they are content-addressed and remain
  pinned by the old host until the new host pins them. The new host
  re-pins on rehydration.

---

## 9. State Synchronization (Multi-Instance Agents)

### 9.1 When an Agent Runs Multiple Instances

Some agents run as multiple replicas for availability or scale (e.g., a
popular `text-generation` agent behind a load balancer). These replicas
share an `AgentId` (same keypair) but run on different hosts. Their state
must stay consistent.

### 9.2 What Must Be Synchronized

| State | Sync strategy | Consistency |
|-------|---------------|-------------|
| Agent identity | Shared keypair (read from same encrypted blob) | Strong (read-only) |
| Capability registry | Leader-elected writes, pub/sub fan-out | Eventual |
| Trust ledger | CRDT-style merge (scores are monotonic counters) | Eventual |
| Usage counters | CRDT (G-counter) — each replica increments its own counter, sums on read | Eventual |
| Long-term memory | Append-only log replicated via pub/sub; vector DB re-indexes | Eventual |
| Session state | Session affinity — each session pinned to one replica | Strong (single-writer) |
| DHT record | Only the leader republishes | Strong (single-writer) |

### 9.3 Session Affinity for Multi-Instance

The simplest way to keep session state consistent is to ensure each session
is served by exactly one replica. This is *session affinity* (per
`SESSION_AFFINITY_DESIGN.md`). The load balancer (or the client's
connection pool) routes all requests for a given `SessionId` to the same
replica.

If that replica fails, the session fails over to another replica, but the
session state is lost (unless backed by Redis, in which case any replica
can resume it). This is why Redis is the recommended session store for
multi-instance agents (§6.4).

### 9.4 CRDT Counters for Usage

Usage counters use a G-counter (grow-only counter) CRDT: each replica `i`
maintains `counter[i]`, and the total is `sum(counter[j] for all j)`.
Replicas periodically broadcast their counter vector via pub/sub. This
gives an eventually-consistent total without coordination on every
increment.

```rust
pub struct GCounter {
    replica_id: u8,
    counts: HashMap<u8, u64>,   // replica_id -> count
}

impl GCounter {
    fn increment(&mut self, n: u64) {
        *self.counts.entry(self.replica_id).or_insert(0) += n;
    }
    fn value(&self) -> u64 {
        self.counts.values().sum()
    }
    fn merge(&mut self, other: &GCounter) {
        for (k, v) in &other.counts {
            self.counts.entry(*k).and_modify(|e| *e = (*e).max(*v)).or_insert(*v);
        }
    }
}
```

### 9.5 Pub/Sub for State Propagation

Multi-instance agents use a pub/sub channel (Redis Pub/Sub, NATS, or AAFP's
own pubsub backchannel per `PUBSUB_BACKCHANNEL_DESIGN.md`) for state
propagation:

- **`state.registry.changed`** — leader broadcasts new capability registry;
  replicas update their local copy.
- **`state.trust.updated`** — a replica broadcasts a trust score update;
  others merge it.
- **`state.usage.sync`** — periodic G-counter vector broadcast.
- **`state.memory.appended`** — a replica appended to long-term memory;
  others append and re-index.
- **`state.session.invalidated`** — a replica evicted a session; others
  clear any cached reference.

---

## 10. Conversation Memory

### 10.1 Three Tiers of Conversation Memory

An LLM agent's memory is not one thing — it is three layered stores with
different retention policies and access patterns.

```
┌──────────────────────────────────────────────────┐
│  SHORT-TERM (session)                            │
│  The current conversation, up to context window  │
│  Storage: SessionState.conversation              │
│  Retention: session lifetime                     │
├──────────────────────────────────────────────────┤
│  LONG-TERM (vector DB)                           │
│  Summarized, embedded memories for retrieval     │
│  Storage: Vector database                        │
│  Retention: indefinite, importance-weighted      │
├──────────────────────────────────────────────────┤
│  EPISODIC (event log)                            │
│  Chronological log of significant events         │
│  Storage: SQLite episodic_events table           │
│  Retention: configurable (default 90 days)       │
└──────────────────────────────────────────────────┘
```

### 10.2 Short-Term Memory (Session)

Short-term memory is the `conversation` field of `SessionState` (§3.3). It
holds the raw message history for the active session, up to the agent's
context window. When the conversation approaches the context window limit,
the agent applies one of these strategies:

1. **Truncation:** drop the oldest messages (simplest, loses early context).
2. **Summarization:** the agent generates a summary of the oldest N
   messages, replaces them with a single `System` message containing the
   summary, and continues. This preserves long-range context at the cost
   of a summarization call.
3. **Promotion:** the oldest messages are summarized and *promoted* to
   long-term memory (§10.3) before being dropped from the session. This is
   the recommended strategy for agents that should learn from every
   conversation.

### 10.3 Long-Term Memory (Vector DB)

Long-term memory stores `MemoryEntry` records (§6.7), each with an
embedding, content, source session, timestamp, importance score, and tags.
The agent retrieves relevant memories by embedding the current query and
performing a top-k nearest-neighbor search.

**When to write to long-term memory:**

- At the end of each session (episodic summary).
- When the agent learns a new fact ("the user's timezone is PST").
- When a significant event occurs (a tool call succeeded/failed in a
  notable way).
- When the user explicitly says "remember this."

**Importance scoring:** the agent assigns an importance score (0–100) to
each memory. Trivial interactions score low (and are evicted first during
GC); user preferences and learned facts score high. The score can be
LLM-generated ("how important is this memory?") or heuristic-based.

### 10.4 Episodic Memory (Event Log)

Episodic memory is an append-only log of significant events, stored in the
`episodic_events` SQLite table (§6.3). Unlike long-term memory, it is
chronological and not embedded — it's for "what happened when" queries,
not semantic retrieval.

**Event types:**

- `session.started`, `session.ended`
- `message.sent`, `message.received`
- `tool.called`, `tool.result`
- `approval.requested`, `approval.granted`, `approval.denied`
- `capability.invoked`, `capability.failed`
- `cost.incurred`
- `trust.updated`
- `migration.started`, `migration.completed`
- `error` (with stack trace / context)

Episodic events are the audit trail. They are retained for a configurable
period (default 90 days) and then compacted: daily rollups summarize the
event counts and notable incidents, and the raw events are deleted.

### 10.5 Memory Retrieval at Turn Start

At the start of each turn, the agent assembles its context from all three
tiers:

```
context = [
    system_prompt,
    retrieved_long_term_memories,   // top-k from vector DB
    relevant_episodic_events,       // recent events from this session
    short_term_conversation,        // from SessionState
    current_user_message,
]
```

The agent must fit this into its advertised context window (§11.4). If the
assembled context exceeds the window, it drops the lowest-importance
long-term memories first, then truncates episodic events, then summarizes
the oldest short-term messages.

---

## 11. Context Window Management

### 11.1 Advertising Context Window Size

Each LLM agent advertises its context window in the capability metadata so
that routers and clients can select appropriately. Per
`LLM_AGENT_INTEGRATION.md` §2.2, this is in the `CapabilityDescriptor`
metadata map:

```cbor
CapabilityDescriptor = {
    1: "text-generation",
    2: {
        "context-window": "128000",
        "supports-streaming": "true",
        "supports-tools": "true",
    },
}
```

The `context-window` value is the *effective* window — the number of tokens
the agent can accept as input *after* reserving space for its system prompt
and the expected output. A 128k-token model with a 4k-token system prompt
and 4k-token output budget advertises `context-window = 120000`.

### 11.2 The Context Budget Protocol

When a client sends a request, it includes the conversation context. The
agent validates that the context fits:

```rust
async fn validate_context(req: &Request, cap: &CapabilityEntry) -> Result<()> {
    let window = cap.metadata.get("context-window")
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(8192);
    let token_count = estimate_tokens(&req.text);
    if token_count > window {
        return Err(HandlerError::Capability(format!(
            "context too large: {} > {} tokens", token_count, window
        )));
    }
    Ok(())
}
```

If the context is too large, the agent returns a `ContextTooLarge` error
with the max accepted size, so the client can truncate and retry.

### 11.3 Context Window Negotiation

For agents that support multiple models with different windows (e.g., a
wrapper that can route to GPT-4-128k or GPT-4-32k based on cost), the
context window is *per-capability-instance*. The agent publishes two
`CapabilityDescriptor`s with the same name but different metadata, and the
router selects based on the client's stated context size requirement.

### 11.4 Reserving Space for Output

A common failure mode is filling the context window entirely with input,
leaving no room for the model to generate output. The agent reserves an
output budget:

```
effective_input_window = context_window - system_prompt_tokens - output_budget
```

Default `output_budget` is 4096 tokens. This is advertised as
`"max-output-tokens"` in the capability metadata.

---

## 12. Memory Budget

### 12.1 The < 100 MB Target

An AAFP agent should be able to run on a 512 MB VM alongside other agents.
The state budget target is **< 100 MB per agent**, allocated as follows:

| Component | Budget | Notes |
|-----------|--------|-------|
| Ephemeral (per-stream) | ~1 MB × max_streams | Bounded by concurrency limit |
| Session state | ~500 KB × active_sessions | Dominated by conversation context |
| Persistent (identity, registry, trust, usage) | < 5 MB | Small structured data |
| Long-term memory (vector DB) | < 50 MB | ~100k memories at 512 bytes each |
| Episodic log | < 20 MB | 90-day retention, then compacted |
| DHT record cache | < 5 MB | Cached peer records for routing |
| Blob cache (IPFS) | < 20 MB | Separate eviction policy |
| **Total** | **< 100 MB** | (excluding ephemeral, which is bounded separately) |

### 12.2 Advertising the Budget

The agent advertises its `state_budget_bytes` in the
`aafp.perf.v1` extension so that orchestrators can avoid overloading a
host:

```cbor
"aafp.perf.v1": { 1: 1, 2: {
    1: 200,        // avg_latency_ms
    2: 800,        // p99_latency_ms
    3: 50,         // throughput_rps
    4: 100,        // max_concurrent
    9: 104857600,  // state_budget_bytes (100 MB)
}}
```

### 12.3 Budget Enforcement

The runtime tracks state size per tier and triggers eviction when
approaching the budget:

```rust
pub struct StateBudget {
    pub ephemeral_bytes: AtomicU64,
    pub session_bytes: AtomicU64,
    pub persistent_bytes: AtomicU64,
    pub memory_bytes: AtomicU64,
    pub limit: u64,
}

impl StateBudget {
    pub fn check(&self) -> BudgetAction {
        let total = self.persistent_bytes.load()
            + self.memory_bytes.load()
            + self.session_bytes.load();
        let ratio = total as f64 / self.limit as f64;
        match ratio {
            r if r > 1.0 => BudgetAction::EmergencyEvict,
            r if r > 0.9 => BudgetAction::AggressiveEvict,
            r if r > 0.8 => BudgetAction::StartEviction,
            _ => BudgetAction::None,
        }
    }
}
```

**Eviction order (most expendable first):**

1. Ephemeral state for completed requests (should already be gone).
2. Idle session state past the soft timeout (reduce TTL).
3. Low-importance long-term memories (importance < 20).
4. Old episodic events (beyond 30 days).
5. DHT record cache entries (can be re-fetched).
6. Blob cache entries (can be re-fetched from IPFS).

Persistent identity, registry, and trust ledger are *never* evicted — they
are essential.

---

## 13. Garbage Collection

### 13.1 Session State GC

The `SessionManager` runs a periodic `evict_idle` task (default every 60
seconds) that removes sessions idle for longer than `idle_timeout` (default
30 minutes). The eviction:

1. Calls `store.evict_idle(timeout)`.
2. For each evicted session, cancels any lingering active streams.
3. Promotes the session's conversation to long-term memory (summarized)
   if the session had significant content (> 5 turns).
4. Emits a `session.expired` episodic event.

### 13.2 DHT Record GC

DHT records expire via TTL (key 6, `expires_at`). The DHT itself handles
eviction of expired records. The agent's responsibility is *republish*
(§5.4) — if it fails to republish, the record ages out and the agent
becomes undiscoverable. This is the desired behavior: an agent that has
crashed permanently should become undiscoverable, not linger as a stale
endpoint.

**Stale endpoint cleanup:** even if the record is republished, individual
endpoints may become stale (e.g., a relay that went down). Clients detect
this via failed connection attempts and report it back through the
`aafp.perf.v1` attestation system, lowering the endpoint's trust score.
The agent itself runs a periodic endpoint health check and removes
unreachable endpoints from its record on the next republish.

### 13.3 Long-Term Memory GC

Long-term memory entries are evicted by a combination of:

- **Importance threshold:** entries with importance < 20 that haven't been
  retrieved in 30 days are candidates for eviction.
- **Age cap:** entries older than 1 year with importance < 50 are
  candidates.
- **Budget pressure:** if the memory tier exceeds its budget (§12.3), the
  lowest-importance entries are evicted until under budget.

Evicted memories are *not* deleted outright — they are moved to a cold
archive (compressed CBOR file on disk) for 30 days before final deletion,
allowing recovery if a memory was wrongly evicted.

### 13.4 Episodic Log GC

Episodic events are deleted after the retention period (default 90 days).
Before deletion, a daily rollup is written:

```cbor
DailyRollup = {
    1: uint,            // day (unix date)
    2: uint,            // total_events
    3: { *tstr => uint },  // event_type counts
    4: uint,            // total_tokens
    5: uint,            // total_cost_micro_usd
    6: [*tstr],         // notable_incidents (error messages, etc.)
}
```

Rollups are retained indefinitely (they're tiny — < 1 KB per day).

### 13.5 Trust Ledger GC

Trust entries for agents not interacted with in 180 days are evicted. The
exponential decay (§4.3) means their scores have already decayed to near-
zero, so eviction loses nothing. The entry is logged in the episodic log
before deletion.

### 13.6 GC Schedule

| Collector | Frequency | Target |
|-----------|-----------|--------|
| Session eviction | 60 s | Idle sessions |
| DHT republish | TTL/2 | Self-record freshness |
| Endpoint health check | 5 min | Unreachable endpoints |
| Memory GC | 1 hour | Low-importance memories |
| Episodic compaction | 1 day | Events > 90 days |
| Trust decay & GC | 1 day | Stale trust entries |
| Blob cache eviction | 1 hour | LRU blobs over budget |
| Usage counter flush | 10 s | Buffered counters to disk |

---

## 14. Concrete Architecture: A Stateful LLM Agent

### 14.1 Overview

This section specifies a concrete architecture for a stateful LLM agent —
the kind that wraps an OpenAI or Anthropic API, maintains multi-turn
conversations, delegates tool calls to other AAFP agents, tracks cost, and
learns over time. It fits in < 100 MB.

```
┌──────────────────────────────────────────────────────────────┐
│                    StatefulLLMAgent                           │
│                                                               │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────┐  │
│  │  Identity    │  │  Capability   │  │   Trust Ledger      │  │
│  │  (encrypted) │  │  Registry     │  │   (local scores)    │  │
│  └─────────────┘  └──────────────┘  └─────────────────────┘  │
│         │                 │                   │               │
│  ┌──────┴─────────────────┴───────────────────┴──────────┐   │
│  │              PersistentStore (SQLite)                  │   │
│  │  agent-state.db  [< 5 MB structured + 20 MB episodic]  │   │
│  └────────────────────────┬───────────────────────────────┘   │
│                           │                                    │
│  ┌────────────────────────┴───────────────────────────────┐   │
│  │              SessionManager                             │   │
│  │  SessionStore: Redis (multi-instance) or SQLite (single)│   │
│  │  ┌─────────────┐ ┌──────────────┐ ┌─────────────────┐  │   │
│  │  │ Conversation│ │ Active       │ │ Pending         │  │   │
│  │  │ Context     │ │ Streams      │ │ Approvals       │  │   │
│  │  └─────────────┘ └──────────────┘ └─────────────────┘  │   │
│  └────────────────────────────────────────────────────────┘   │
│                           │                                    │
│  ┌────────────────────────┴───────────────────────────────┐   │
│  │              LongTermMemory (Vector DB)                 │   │
│  │  LanceDB / pgvector  [< 50 MB, 100k memories]          │   │
│  └────────────────────────────────────────────────────────┘   │
│                           │                                    │
│  ┌────────────────────────┴───────────────────────────────┐   │
│  │              DHT Client (Shared State)                  │   │
│  │  AgentRecord + Attestations + Capability Graph          │   │
│  │  Republish every 12h (24h TTL)                         │   │
│  └────────────────────────────────────────────────────────┘   │
│                                                               │
│  Total state budget: ~80 MB (within 100 MB target)            │
└──────────────────────────────────────────────────────────────┘
```

### 14.2 Startup Sequence

```rust
async fn boot(config: AgentConfig) -> Result<RunningAgent> {
    // 1. Load persistent store
    let store = SqlitePersistentStore::open(&config.state_db_path)?;

    // 2. Load and decrypt identity
    let identity = load_identity(&store, &config.passphrase_source).await?;

    // 3. Load capability registry
    let registry: CapabilityRegistry = store.get_cbor("registry")?.unwrap_or_default();

    // 4. Load trust ledger and usage counters
    let trust: TrustLedger = store.get_cbor("trust")?.unwrap_or_default();
    let usage: UsageCounters = store.get_cbor("usage")?.unwrap_or_default();

    // 5. Open long-term memory (vector DB)
    let memory = LongTermMemory::open(&config.vector_db_path)?;

    // 6. Open session manager
    let session_store = match &config.session_backend {
        SessionBackend::Memory => Arc::new(InMemorySessionStore::new()),
        SessionBackend::Sqlite => Arc::new(SqliteSessionStore::open(&config.state_db_path)?),
        SessionBackend::Redis(url) => Arc::new(RedisSessionStore::connect(url).await?),
    };
    let sessions = SessionManager::new(session_store, config.session_config.clone());

    // 7. Build DHT client and publish agent record
    let dht = DhtClient::bootstrap(&config.seeds, &identity.keypair).await?;
    let record = build_agent_record(&identity, &registry, &config);
    dht.put(identity.agent_id, record).await?;

    // 8. Start background tasks
    let bg = BackgroundTasks::spawn(
        Republisher::new(dht.clone(), identity.clone(), registry.clone()),
        SessionGc::new(sessions.clone()),
        MemoryGc::new(memory.clone()),
        EpisodicCompactor::new(store.clone()),
        UsageFlusher::new(store.clone(), usage.clone()),
        TrustDecay::new(trust.clone()),
    );

    // 9. Start serving
    let server = ServeBuilder::new()
        .keypair(identity.keypair.clone())
        .with_session_manager(sessions.clone())
        .on_capability("text-generation", handle_text_generation)
        .on_capability("tool-use", handle_tool_use)
        .bind(config.bind_addr)
        .serve().await?;

    Ok(RunningAgent { identity, registry, sessions, memory, dht, server, bg })
}
```

### 14.3 Request Handling: A Multi-Turn Chat Turn

```rust
async fn handle_text_generation(
    req: Request,
    ctx: HandlerContext,
    sessions: Arc<SessionManager>,
    memory: Arc<LongTermMemory>,
    registry: Arc<CapabilityRegistry>,
    usage: Arc<UsageCounters>,
    llm_client: Arc<LlmClient>,
) -> Result<Response, HandlerError> {
    let session_id = req.metadata.session_id
        .ok_or(HandlerError::Protocol("missing session_id"))?;

    // 1. Load or create session state
    let mut state = sessions.get_or_create(session_id, req.peer_id).await?;

    // 2. Validate context fits the window
    let cap = registry.find("text-generation")?;
    validate_context(&req, cap)?;

    // 3. Retrieve relevant long-term memories
    let memories = memory.retrieve(&req.text, top_k=5).await?;

    // 4. Assemble full context
    let mut context = state.conversation.clone();
    context.insert_system_memories(memories);
    context.push_user_message(req.text.clone());

    // 5. Call the LLM (streaming)
    let stream = llm_client.generate_streaming(&context).await?;

    // 6. Stream tokens back, accumulate full response
    let full_response = forward_stream(stream, |chunk| {
        // Each chunk is emitted as a TokenChunk frame
        emit_token_chunk(chunk);
    }).await?;

    // 7. Update session state
    context.push_assistant_message(full_response.text.clone(), full_response.tool_calls.clone());
    state.conversation = context.compact_if_needed(cap.context_window);
    state.token_usage.add(&full_response.usage);
    sessions.put(session_id, state).await?;

    // 8. Record usage
    usage.add(&full_response.usage).await;

    // 9. Log episodic event
    episodic_log::append("message.sent", &full_response).await;

    // 10. If conversation is getting long, promote a summary to long-term memory
    if state.conversation.len() > 20 {
        let summary = summarize(&state.conversation).await?;
        memory.store(summary.content, summary.embedding, importance=50).await?;
    }

    Ok(Response::text(full_response.text))
}
```

### 14.4 Tool-Use Delegation with Pending Approvals

When the LLM emits a tool call, the agent checks whether the tool requires
approval (based on a risk classification in the capability registry). If
so, it enqueues a `PendingApproval` and suspends the turn:

```rust
async fn handle_tool_use(/* ... */) -> Result<Response, HandlerError> {
    let tool_call = parse_tool_call(&req)?;
    let cap = registry.find(&tool_call.capability)?;

    if cap.requires_approval {
        let approval = PendingApproval {
            approval_id: Uuid::new_v4().into(),
            capability: tool_call.capability.clone(),
            params: tool_call.params.clone(),
            rationale: tool_call.rationale.clone(),
            risk_score: cap.risk_score,
            created_at: now(),
            deadline: now() + 300,  // 5 min
            status: ApprovalStatus::Pending,
        };
        sessions.add_pending_approval(session_id, approval.clone()).await?;

        // Surface to client via approval.request capability
        emit_approval_request(approval).await?;

        // Suspend — the response is sent when approval is granted or denied
        let outcome = wait_for_approval(approval.approval_id, ctx.cancel).await?;
        match outcome {
            ApprovalStatus::Approved => delegate_to_peer(cap, tool_call.params).await,
            ApprovalStatus::Denied => Ok(Response::text("Tool call denied by user.")),
            ApprovalStatus::Expired => Ok(Response::text("Tool call timed out awaiting approval.")),
            _ => unreachable!(),
        }
    } else {
        delegate_to_peer(cap, tool_call.params).await
    }
}
```

### 14.5 Shutdown Sequence

```rust
async fn shutdown(agent: RunningAgent) -> Result<()> {
    // 1. Stop accepting new requests
    agent.server.stop_graceful(Duration::from_secs(30)).await?;

    // 2. Wait for in-flight streams to complete or cancel
    agent.server.await_drain().await?;

    // 3. Flush usage counters
    agent.usage.flush().await?;

    // 4. Persist session state (if SQLite-backed; Redis is already persistent)
    agent.sessions.flush().await?;

    // 5. Checkpoint the persistent store (SQLite WAL checkpoint)
    agent.store.checkpoint().await?;

    // 6. Unpublish from DHT (optional — can let TTL expire)
    agent.dht.evict(agent.identity.agent_id).await?;

    // 7. Stop background tasks
    agent.bg.stop().await?;

    Ok(())
}
```

---

## 15. Security Considerations

### 15.1 Keypair Protection

The agent's private key is the root of its identity. Compromise means
impersonation. Mitigations:

- Encrypted at rest (Argon2id + XChaCha20-Poly1305).
- Never logged, never serialized unencrypted, never sent over the network.
- In memory, held in a `Zeroizing` wrapper that zeroes memory on drop.
- Accessible only via the `AgentKeypair` type, which exposes only `sign()`
  and `public_key()` — no raw key export.

### 15.2 Session State Privacy

Session state contains conversation content — potentially sensitive. It is
stored locally and never published to the DHT. For multi-instance
deployments using Redis, Redis MUST be configured with TLS in transit and
encryption at rest. The session store MAY encrypt the CBOR `SessionState`
blob with a session-store key (distinct from the identity key) for
defense-in-depth.

### 15.3 Migration Bundle Confidentiality

The migration bundle is encrypted to the target host's public key (§8.3).
Even if intercepted, it cannot be decrypted without the target's private
key. The bundle's integrity is verified via SHA-256 after decryption.

### 15.4 Attestation Integrity

Attestations are signed by the attester's keypair. A consumer of an
attestation MUST verify the signature and check that the attester is
trusted (per the consumer's `TrustLedger`). Self-attestations are
ignored — only third-party attestations count.

### 15.5 Memory Sanitization

When an agent is permanently decommissioned, the operator runs
`agent.purge()`:

1. Delete the persistent store file (`agent-state.db`).
2. Delete the vector DB directory.
3. Unpublish the DHT record and request eviction.
4. Unpin all IPFS blobs owned by this agent.
5. Clear the Redis session keys (`SESSION:{agent_id}:*`).
6. Shred the encrypted identity blob (secure delete).

This ensures no recoverable state remains.

---

## 16. Observability

### 16.1 State Metrics

The agent exposes state-related metrics via the standard AAFP metrics
endpoint:

| Metric | Type | Description |
|--------|------|-------------|
| `state.ephemeral_bytes` | gauge | Current ephemeral state size |
| `state.session_count` | gauge | Active sessions |
| `state.session_bytes` | gauge | Total session state size |
| `state.persistent_bytes` | gauge | Persistent store size |
| `state.memory_count` | gauge | Long-term memory entries |
| `state.memory_bytes` | gauge | Long-term memory size |
| `state.dht_record_age_seconds` | gauge | Time since last republish |
| `state.gc.evicted_sessions` | counter | Sessions evicted by GC |
| `state.gc.evicted_memories` | counter | Memories evicted by GC |
| `state.budget.ratio` | gauge | Used/limit ratio |

### 16.2 Episodic Log as Audit Trail

The episodic event log (§10.4) serves as the audit trail. It is
append-only (no updates, no deletes until compaction), stored in SQLite
with WAL mode for durability. For compliance-sensitive deployments, the
episodic log can be mirrored to an external append-only store (e.g., AWS
Qldb, a blockchain) via a pluggable sink.

---

## 17. Implementation Phasing

### Phase 1: Foundation (P2.7-aligned)
- `SessionManager` with `InMemorySessionStore` (already specified in
  `SESSION_AFFINITY_DESIGN.md` §4).
- `PersistentStore` trait with `SqlitePersistentStore`.
- Agent identity load/save with encryption.
- CBOR serialization for all persistent structures.

### Phase 2: Production Backends
- `SqliteSessionStore` (cross-restart session persistence).
- `RedisSessionStore` (multi-instance).
- Long-term memory with embedded vector DB (LanceDB).
- Episodic event log in SQLite.

### Phase 3: Migration & Sync
- Migration bundle serialization and the `agent.migrate` capability.
- CRDT counters for multi-instance usage.
- Pub/sub state propagation for multi-instance agents.

### Phase 4: Memory Intelligence
- Conversation summarization and promotion to long-term memory.
- Importance scoring (LLM-assisted).
- Context assembly from all three memory tiers.
- Budget enforcement with tiered eviction.

### Phase 5: Hardening
- Encrypted session store (defense-in-depth).
- Secure delete / purge on decommission.
- Episodic log mirroring to external audit store.
- Full observability metrics.

---

## 18. Open Questions

1. **Session migration vs. session resumption.** Currently, sessions are
   not migrated across hosts (§8.4). Should AAFP support live session
   migration for agents that must not lose conversation context on
   failover? This would require migrating active QUIC streams, which is
   complex. Alternative: clients always retain the conversation context
   and resend it on failover, making server-side session state a cache
   rather than the source of truth.

2. **Long-term memory sharing.** Should long-term memory be shareable
   across agents (e.g., a team of agents sharing a knowledge base)? This
   would require a multi-writer vector DB with access control. Currently
   long-term memory is per-agent.

3. **Memory importance calibration.** The importance score (0–100) is
   currently LLM-generated or heuristic. Should it be calibrated by
   observed retrieval frequency (memories that are retrieved often get
   higher importance)? This is a reinforcement-learning approach to
   memory retention.

4. **DHT record size vs. extensions.** The < 4 KB target for DHT records
   may be exceeded by agents with many capabilities and rich semantic
   descriptors. Should large records be split (core record in DHT,
   extensions in IPFS by CID)? This adds a fetch round-trip for
   discovery.

5. **Cross-agent trust propagation.** If agent A trusts agent B, and B
   trusts C, does A trust C (transitive trust)? The current design keeps
   trust local and non-transitive. Transitive trust is a federation-level
   concern (per `FEDERATION_TRUST.md`) and may warrant a separate web-of-
   trust computation.

---

## 19. References

- `SESSION_AFFINITY_DESIGN.md` §4 — SessionManager, SessionStore trait
- `SIMPLE_API_V2_DESIGN.md` §5 — RequestMetadata, session_id, trace_id
- `STREAMING_RPC_DESIGN.md` — TokenChunk streaming, cancellation
- `AGENT_RECORD_EXTENSIONS.md` — AgentRecord CBOR, extensions, attestations
- `SEMANTIC_CAPABILITY_GRAPHS.md` — CapabilityEdge, Specializes/Composes
- `FEDERATION_TRUST.md` — Trust scoring, web-of-trust, attestation verification
- `LLM_AGENT_INTEGRATION.md` §2 — Capability advertisement, context-window metadata
- `PERFORMANCE_SCALABILITY.md` — Memory budgets, concurrency limits
- `PUBSUB_BACKCHANNEL_DESIGN.md` — Pub/sub for multi-instance state propagation
- `INTERNET_BRIDGE_PLAN.md` §4.3 — Well-known capabilities, provider wrapping
- RFC-0003 — CBOR as the AAFP wire serialization format
- RFC-8949 — Concise Binary Object Representation (CBOR)
- RFC-0005 — Error codes (HandlerError mapping)

---

*End of document. ~620 lines.*
