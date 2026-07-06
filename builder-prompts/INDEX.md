# Builder Prompts Index

21 ready-to-build prompts covering the TypeScript SDK (9 phases) and all future
tracks (Semantic Capability Graphs, Adaptive Routing, PubSub, AgentRecord
Extensions). Total: ~26,200 lines of detailed implementation guidance.

## TypeScript SDK (9 phases, ~11,200 lines)

| Phase | File | Lines | Description |
|-------|------|-------|-------------|
| TS-1 | `TS_PHASE_1_CBOR_CRYPTO.md` | 1,306 | Pure-TS CBOR, ML-DSA-65, HKDF, AEAD, AgentId |
| TS-2 | `TS_PHASE_2_TRANSPORT.md` | 1,763 | Transport interface, Node QUIC, WebTransport, WebSocket, frames |
| TS-3 | `TS_PHASE_3_SERVER.md` | 1,702 | ServeBuilder, onCapability, HandlerContext, HandlerError, handshake |
| TS-4 | `TS_PHASE_4_CLIENT.md` | 1,407 | ConnectBuilder, ConnectedAgent, DiscoveryBuilder, ConnectionPool |
| TS-5 | `TS_PHASE_5_STREAMING.md` | 1,285 | StreamingHandlerContext, ResponseStream, onStreaming, callStreaming |
| TS-6 | `TS_PHASE_6_BROWSER.md` | 1,038 | WebTransport, WebSocket bridge, isomorphic API, React/Vue/Svelte |
| TS-7 | `TS_PHASE_7_MCP.md` | 943 | MCP TS SDK wrapping, LangChain.js, Vercel AI SDK integration |
| TS-8 | `TS_PHASE_8_TESTING.md` | 711 | Vitest, cross-language vectors, conformance, golden traces, CI |
| TS-9 | `TS_PHASE_9_PACKAGING.md` | 921 | npm monorepo, ESM/CJS, Deno/Bun, TypeDoc, publishing workflow |

**Dependency order:** TS-1 → TS-2 → (TS-3, TS-4 parallel) → TS-5 → TS-6 → TS-7 → TS-8 → TS-9

## Semantic Capability Graphs (3 prompts, ~2,900 lines)

| Phase | File | Lines | Description |
|-------|------|-------|-------------|
| D1-D2 | `SCG_D1_D2_DESCRIPTOR_QUERY.md` | 1,081 | SemanticCapability, CBOR encoding, CapabilityQuery, QueryFilter |
| D3-D4 | `SCG_D3_D4_INDEX_COMPOSE.md` | 700 | CapabilityIndex, CapabilityGraph, PipelineAssembler, topological sort |
| D5-D6 | `SCG_D5_D6_PLAN_BRIDGE.md` | 1,140 | CapabilityPlanner, heuristic+A* search, 11 internet bridge capabilities |

**Dependency order:** D1-D2 → D3-D4 → D5-D6

## Adaptive Routing Plane (3 prompts, ~3,500 lines)

| Phase | File | Lines | Description |
|-------|------|-------|-------------|
| T1-T2 | `AR_T1_T2_METRICS_ROUTING.md` | 1,416 | PeerMetricsRegistry, EWMA, RollingWindow, 4 selection strategies |
| T3-T4 | `AR_T3_T4_BREAKER_HEDGING.md` | 1,129 | CircuitBreaker (3-state), bulkhead, request hedging, retry+backoff |
| T5-T7 | `AR_T5_T7_INTEGRATION_API.md` | 986 | Track U integration, RoutingConfig, per-call overrides, observability |

**Dependency order:** T1-T2 → T3-T4 → T5-T7 (T5-T7 also depends on SCG D1-D2)

## PubSub + Back-Channeling (3 prompts, ~3,700 lines)

| Phase | File | Lines | Description |
|-------|------|-------|-------------|
| P1-P2 | `PS_P1_P2_API_PROPAGATION.md` | 1,673 | Simple API, Event, SubscriptionStream, propagation driver fix |
| P3-P4 | `PS_P3_P4_BACKCHANNEL_ROUTING.md` | 1,203 | Back-channel topics, MQTT wildcards, TopicMatcher, streaming integration |
| P5-P6 | `PS_P5_P6_SECURITY_GOSSIPSUB.md` | 866 | UCAN ACLs, per-connection limits, GossipSub v1.1, peer scoring |

**Dependency order:** P1-P2 → P3-P4 → P5-P6

## AgentRecord Extensions (3 prompts, ~5,000 lines)

| Phase | File | Lines | Description |
|-------|------|-------|-------------|
| E1-E2 | `ARE_E1_E2_MAP_GEO_PERF.md` | 984 | Extension trait, CBOR key 11, GeoExtension, PerformanceExtension |
| E3-E4 | `ARE_E3_E4_COST_SEMANTIC_REPUTATION.md` | 2,188 | Cost, Semantic, Version, Reputation extensions, attestation, UCAN |
| E5-E6 | `ARE_E5_E6_DHT_TESTING.md` | 1,793 | DHT integration, secondary indexing, heartbeats, adaptive TTL, tests |

**Dependency order:** E1-E2 → E3-E4 → E5-E6

## Build Order (across all tracks)

```
Phase 1 (now):      P2.8 (in progress) — Streaming + Cancellation
Phase 2 (next):     TS-1 → TS-2 — CBOR/Crypto + Transport foundation
Phase 3 (parallel): TS-3 + TS-4 — Server + Client API (parallel)
Phase 4:            TS-5 — Streaming
Phase 5 (parallel): SCG D1-D2 + ARE E1-E2 — Semantic descriptors + Extension map
Phase 6 (parallel): SCG D3-D4 + ARE E3-E4 — Indexing + Cost/Reputation
Phase 7 (parallel): AR T1-T2 + PS P1-P2 — Metrics/Routing + PubSub API
Phase 8 (parallel): AR T3-T4 + PS P3-P4 — Breaker/Hedging + BackChannel
Phase 9 (parallel): AR T5-T7 + PS P5-P6 — Integration + Security/GossipSub
Phase 10 (parallel): SCG D5-D6 + ARE E5-E6 — Planning + DHT integration
Phase 11:           TS-6 → TS-7 — Browser + MCP
Phase 12:           TS-8 → TS-9 — Testing + Packaging
```

## Cross-Track Dependencies

```
SCG D1-D2 ──→ AR T5-T7 (routing uses semantic scoring)
ARE E1-E2 ──→ ARE E3-E4 ──→ ARE E5-E6
ARE E3-E4 ──→ SCG D5-D6 (planner uses reputation/cost)
PS P1-P2  ──→ PS P3-P4  ──→ PS P5-P6
TS-1      ──→ TS-2      ──→ TS-3 + TS-4 ──→ TS-5
```
