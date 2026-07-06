# AAFP Adaptation Roadmap

**Status:** Living Document
**Date:** 2025-01-15
**Synthesizes:** 8 sandbox gap analyses + 5 completed research tracks

---

## 1. Origin: Gap Analysis Summary

Eight parallel sandbox tests exercised the AAFP Simple API against mainstream agentic patterns (MCP tool servers, CrewAI/AutoGen orchestration, LangChain pipelines, browser automation, RAG pipelines, code execution sandboxes, event-driven webhooks, streaming + human-in-the-loop). All eight confirmed the same set of critical gaps:

### 1.1 Confirmed Gaps (10 total)

| # | Gap | Impact | Sandboxes Affected |
|---|-----|--------|-------------------|
| 1 | **No structured request/response** — text XOR binary only, despite CBOR Map support | Forces JSON-in-text workarounds | 8/8 |
| 2 | **Capability name not forwarded to handler** — handler gets generic "call" method | Forces body-prefix dispatch hacks | 8/8 |
| 3 | **No streaming responses** — strictly request/response | Blocks LLM token streaming, progress updates | 8/8 |
| 4 | **No session affinity / connection reuse** — each call dials + handshakes | 50x performance overhead | 8/8 |
| 5 | **No request metadata** — session IDs, deadlines must go in body | Fragile, no standard context | 6/8 |
| 6 | **One handler per ServeBuilder** — no per-capability routing | Forces manual dispatch | 5/8 |
| 7 | **No handler cancellation** — orphaned handlers on client disconnect | Resource waste | 4/8 |
| 8 | **No typed error codes** — single 5000+string | Poor error handling | 5/8 |
| 9 | **DiscoveryBuilder borrows &SdkAgent** — not 'static, can't spawn | Limits async patterns | 3/8 |
| 10 | **discover() only tries [0]** — no failover | Single point of failure | 4/8 |

### 1.2 Additional Gaps (from research)

| # | Gap | Source |
|---|-----|--------|
| 11 | RFC-0009 PubSub not exposed via simple API | Gap analysis |
| 12 | No TypeScript SDK (only Rust + Python) | NORTH_STAR requirement |
| 13 | No adaptive routing (static discovery only) | Track T research |
| 14 | No semantic capability descriptions (string-only) | Track U research |

---

## 2. Completed Research Documents

| Document | Track | Status | Key Finding |
|----------|-------|--------|-------------|
| `SIMPLE_API_V2_DESIGN.md` | Simple API v2 | Complete | Addresses all 10 gaps with backward-compatible v2 API |
| `STREAMING_RPC_DESIGN.md` | Streaming RPC | Complete | No wire protocol changes needed — QUIC primitives already exist |
| `SESSION_AFFINITY_DESIGN.md` | Connection Reuse | Complete | 50x perf improvement by integrating existing ConnectionPool |
| `SEMANTIC_CAPABILITY_GRAPHS.md` | Track U | Complete (summary) | Lightweight ontology + CBOR, no full OWL/RDF needed |

### 2.1 Pending Research (rate-limited, need retry)

| Document | Track | Status |
|----------|-------|--------|
| AgentRecord Extensions | Identity | Pending retry |
| PubSub + Back-Channeling | Messaging | Pending retry |
| TypeScript SDK Architecture | SDK | Pending retry |
| Adaptive Routing Plane | Track T | Pending retry |

---

## 3. Adaptation Roadmap

### Phase A: Simple API v2 (Weeks 1-10)

**Goal**: Address all 10 confirmed gaps with a backward-compatible v2 API.

**Source**: `SIMPLE_API_V2_DESIGN.md`

| Sub-phase | Duration | Deliverables |
|-----------|----------|-------------|
| A1: Foundation | W1-2 | Params, RequestMetadata, ResponseMetadata, HandlerContext, HandlerError |
| A2: Server-side | W3-4 | Per-capability handler routing, on_capability(), cancellation, streaming handlers |
| A3: Client-side | W5-6 | ConnectionPool integration, failover, discover_by_id(), Arc<SdkAgent> |
| A4: Streaming | W7-8 | Server-streaming, bidirectional, ResponseStream, client streaming API |
| A5: Migration | W9-10 | v1 compat wrappers, deprecation, migration guide, update tests |

**Key Design Decisions**:
- v1 API stays as deprecated but functional (no breaking changes)
- v2 adds `Params` type wrapping CBOR IntMap for structured data
- `HandlerContext` carries `CancellationToken` + capability name
- `ConnectionPool` integrated into `ConnectedAgent` (50x perf improvement)
- `HandlerError` enum maps to RFC-0005 error codes
- Discovery uses `Arc<SdkAgent>` for 'static lifetimes + failover

### Phase B: Streaming RPC (Weeks 3-8, overlaps with Phase A)

**Goal**: Enable server-streaming, client-streaming, and bidirectional RPC.

**Source**: `STREAMING_RPC_DESIGN.md`

| Sub-phase | Duration | Deliverables |
|-----------|----------|-------------|
| B1: Server-streaming | W3-5 | StreamingHandlerFn, call_stream(), MORE flag repurposed |
| B2: Cancellation | W5-6 | CancellationToken, QUIC stream reset mapping, CancellableStream |
| B3: Client-streaming | W6-7 | ClientStreamingHandlerFn, call_client_stream() |
| B4: Bidirectional | W7-8 | BidiStreamingHandlerFn, BidiSession, call_bidi_stream() |
| B5: Backpressure | Future | StreamContext, flow control exposure |
| B6: Progress updates | Future | ProgressInfo, progress extension |

**Key Insight**: **No wire protocol changes required.** All streaming patterns use existing QUIC primitives (bi-streams, MORE flag, stream reset). The gap is entirely in the SDK layer.

### Phase C: Session Affinity + Connection Reuse (Weeks 1-7, overlaps with Phase A)

**Goal**: Integrate existing ConnectionPool into Simple API for 50x performance improvement.

**Source**: `SESSION_AFFINITY_DESIGN.md`

| Sub-phase | Duration | Deliverables |
|-----------|----------|-------------|
| C1: Basic pooling | W1-2 | Arc<ConnectionPool> in ConnectedAgent, with_pool_config() |
| C2: Session affinity | W3 | SessionId return from pool, session-aware routing |
| C3: Server session state | W4 | SessionManager, session_handler(), SessionContext |
| C4: UCAN delegation | W5-6 | Request::with_delegation(), UcanVerifier |
| C5: Metrics | W7 | Pool metrics, PoolStats API, Prometheus integration |

**Key Insight**: `ConnectionPool` already exists in the codebase but isn't used by the Simple API. Integration is primarily wiring, not new development.

### Phase D: Semantic Capability Graphs (Weeks 1-12, future track)

**Goal**: Replace string-based discovery with multi-dimensional semantic queries.

**Source**: `SEMANTIC_CAPABILITY_GRAPHS.md`

| Sub-phase | Duration | Deliverables |
|-----------|----------|-------------|
| D1: Extended CapabilityDescriptor | W1-2 | SemanticCapability struct, CBOR encoding |
| D2: Query builder | W3-4 | CapabilityQuery, QueryFilter, evaluation engine |
| D3: Local indexing | W5-6 | CapabilityIndex with secondary indexes, LSH |
| D4: Capability composition | W7-8 | CapabilityGraph, PipelineAssembler |
| D5: Planning | W9-10 | CapabilityPlanner trait, heuristic planner |
| D6: Internet bridge integration | W11-12 | Semantic descriptors for all bridge capabilities |

**Key Insight**: Use lightweight ontology (not full OWL/RDF). Leverage existing `CapabilityDescriptor.metadata` field. Queries evaluated locally after DHT retrieval.

### Phase E: Pending Research (TBD)

| Track | Research Needed | Dependency |
|-------|----------------|------------|
| AgentRecord Extensions | How to extend AgentRecord with reputation, performance history, geo-location | Phase D |
| PubSub + Back-Channeling | How to expose RFC-0009 PubSub through Simple API | Phase B |
| TypeScript SDK | WASM vs native vs bridge vs napi-rs approach | Phase A (API surface) |
| Adaptive Routing (Track T) | Dynamic metrics overlay on static capability graph | Phase D |

---

## 4. Dependency Graph

```
Phase A (Simple API v2)
  |
  +---> Phase B (Streaming RPC) -- requires A2 (server-side) + A4 (streaming types)
  |
  +---> Phase C (Session Affinity) -- requires A3 (client-side)
  |
  +---> Phase E (TypeScript SDK) -- requires A (stable API surface)

Phase D (Semantic Capability Graphs)
  |
  +---> Phase E (Adaptive Routing) -- requires D (capability graph as base)

Phase B (Streaming RPC)
  |
  +---> Phase E (PubSub) -- requires B (streaming primitives)
```

---

## 5. Priority Matrix

| Priority | Phase | Rationale |
|----------|-------|-----------|
| **P0 (Critical)** | A1-A3 (Foundation + Server + Client) | Addresses 8/10 gaps, unblocks all other work |
| **P0 (Critical)** | C1-C2 (Basic pooling + affinity) | 50x perf improvement, minimal effort (wiring) |
| **P1 (High)** | B1-B2 (Server-streaming + cancellation) | Required for LLM token streaming |
| **P1 (High)** | A4-A5 (Streaming + Migration) | Completes v2 API, enables adoption |
| **P2 (Medium)** | B3-B4 (Client-streaming + bidi) | File upload, interactive REPL |
| **P2 (Medium)** | C3-C4 (Session state + UCAN) | Stateful interactions, multi-agent |
| **P2 (Medium)** | E (TypeScript SDK) | Web/Node.js ecosystem access |
| **P3 (Future)** | D (Semantic Capability Graphs) | Rich discovery, pipeline assembly |
| **P3 (Future)** | E (Adaptive Routing, PubSub) | Dynamic metrics, event-driven |
| **P3 (Future)** | B5-B6 (Backpressure + Progress) | Optimization, nice-to-have |

---

## 6. Success Metrics

| Metric | Current | Target | Phase |
|--------|---------|--------|-------|
| Repeated call latency | 709us | 14us | C1 |
| Streaming token delivery | N/A (polling) | <5ms per token | B1 |
| Handler cancellation time | Never cancels | <10ms | B2 |
| Structured params | JSON-in-text | Native CBOR Map | A1 |
| Per-capability routing | Manual dispatch | Automatic | A2 |
| Discovery failover | None (tries [0]) | All candidates | A3 |
| Typed errors | 5000+string | 8 error categories | A1 |
| SDK languages | 2 (Rust, Python) | 3 (+TypeScript) | E |

---

## 7. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| v2 API too complex, hurts adoption | Medium | High | Keep v1 working, gradual migration |
| Streaming MORE flag ambiguity | Low | Medium | Capability-based mode negotiation |
| ConnectionPool health check overhead | Low | Low | 5s threshold, skip for recent connections |
| Semantic capability overhead | Medium | Medium | Lightweight ontology, CBOR encoding |
| TypeScript SDK approach wrong | Medium | High | Research 4 approaches before choosing |

---

## 8. Next Actions

1. **Immediately**: Begin Phase A1 (Foundation types) + Phase C1 (Basic pooling) — these are independent and can proceed in parallel
2. **Retry pending research**: Re-dispatch 4 rate-limited research agents (AgentRecord, PubSub, TypeScript SDK, Adaptive Routing)
3. **After A1+C1**: Begin A2 (Server-side) + B1 (Server-streaming) in parallel
4. **After A2**: Begin A3 (Client-side) — completes the v2 API surface
5. **After A3**: Begin E (TypeScript SDK) — needs stable API surface first

---

## 9. Document Index

| Document | Description |
|----------|-------------|
| `SIMPLE_API_V2_DESIGN.md` | Complete v2 API design (all 10 gaps) |
| `STREAMING_RPC_DESIGN.md` | Streaming RPC over QUIC (no wire changes) |
| `SESSION_AFFINITY_DESIGN.md` | Connection pooling + session affinity (50x perf) |
| `SEMANTIC_CAPABILITY_GRAPHS.md` | Semantic capability discovery (Track U) |
| `NORTH_STAR.md` | Project north star and strategic vision |
| `INTERNET_BRIDGE_PLAN.md` | World Perception Layer blueprint |
| `PERFORMANCE_REPORT.md` | Performance benchmarks |
| `ROADMAP.md` | Original project roadmap |
