# Builder Prompts Index — ALL COMPLETE ✅

15 prompts for the Intelligence Plane (ALL IMPLEMENTED) + TypeScript SDK 9 phases
(COMPLETE — 151 tests, 7 packages). Total: ~15,000 lines of detailed
implementation guidance across 4 tracks. All 15 Intelligence Plane prompts have
been implemented, tested (84 new tests), and security hardened.

## TypeScript SDK (9 phases) — ✅ ALL COMPLETE

| Phase | File | Lines | Status | Tests |
|-------|------|-------|--------|-------|
| TS-1 | `TS_PHASE_1_CBOR_CRYPTO.md` | 1,306 | ✅ COMPLETE | 43 |
| TS-2 | `TS_PHASE_2_TRANSPORT.md` | 1,763 | ✅ COMPLETE | 20 |
| TS-3 | `TS_PHASE_3_SERVER.md` | 1,702 | ✅ COMPLETE | 60 (with TS-4) |
| TS-4 | `TS_PHASE_4_CLIENT.md` | 1,407 | ✅ COMPLETE | (with TS-3) |
| TS-5 | `TS_PHASE_5_STREAMING.md` | 1,285 | ✅ COMPLETE | 30 |
| TS-6 | `TS_PHASE_6_BROWSER.md` | 1,038 | ✅ COMPLETE | 17 |
| TS-7 | `TS_PHASE_7_MCP.md` | 943 | ✅ COMPLETE | (with TS-6) |
| TS-8 | `TS_PHASE_8_TESTING.md` | 711 | ✅ COMPLETE | 11 |
| TS-9 | `TS_PHASE_9_PACKAGING.md` | 921 | ✅ COMPLETE | (with TS-8) |

**Total: 151 TypeScript tests passing, 0 errors**

## Semantic Capability Graphs (3 prompts, ~2,900 lines) — ✅ ALL COMPLETE

| Phase | File | Lines | Description | Status |
|-------|------|-------|-------------|--------|
| D1-D2 | `SCG_D1_D2_DESCRIPTOR_QUERY.md` | 1,081 | SemanticCapability, CBOR encoding, CapabilityQuery, QueryFilter | ✅ COMPLETE |
| D3-D4 | `SCG_D3_D4_INDEX_COMPOSE.md` | 700 | CapabilityIndex, CapabilityGraph, PipelineAssembler, topological sort | ✅ COMPLETE |
| D5-D6 | `SCG_D5_D6_PLAN_BRIDGE.md` | 1,140 | CapabilityPlanner, heuristic+A* search, 11 internet bridge capabilities | ✅ COMPLETE |

**Dependency order:** D1-D2 → D3-D4 → D5-D6

## Adaptive Routing Plane (3 prompts, ~3,500 lines) — ✅ ALL COMPLETE

| Phase | File | Lines | Description | Status |
|-------|------|-------|-------------|--------|
| T1-T2 | `AR_T1_T2_METRICS_ROUTING.md` | 1,416 | PeerMetricsRegistry, EWMA, RollingWindow, 4 selection strategies | ✅ COMPLETE |
| T3-T4 | `AR_T3_T4_BREAKER_HEDGING.md` | 1,129 | CircuitBreaker (3-state), bulkhead, request hedging, retry+backoff | ✅ COMPLETE |
| T5-T7 | `AR_T5_T7_INTEGRATION_API.md` | 986 | Track U integration, RoutingConfig, per-call overrides, observability | ✅ COMPLETE |

**Dependency order:** T1-T2 → T3-T4 → T5-T7 (T5-T7 also depends on SCG D1-D2)

## PubSub + Back-Channeling (3 prompts, ~3,700 lines) — ✅ ALL COMPLETE

| Phase | File | Lines | Description | Status |
|-------|------|-------|-------------|--------|
| P1-P2 | `PS_P1_P2_API_PROPAGATION.md` | 1,673 | Simple API, Event, SubscriptionStream, propagation driver fix | ✅ COMPLETE |
| P3-P4 | `PS_P3_P4_BACKCHANNEL_ROUTING.md` | 1,203 | Back-channel topics, MQTT wildcards, TopicMatcher, streaming integration | ✅ COMPLETE |
| P5-P6 | `PS_P5_P6_SECURITY_GOSSIPSUB.md` | 866 | UCAN ACLs, per-connection limits, GossipSub v1.1, peer scoring | ✅ COMPLETE |

**Dependency order:** P1-P2 → P3-P4 → P5-P6

## AgentRecord Extensions (3 prompts, ~5,000 lines) — ✅ ALL COMPLETE

| Phase | File | Lines | Description | Status |
|-------|------|-------|-------------|--------|
| E1-E2 | `ARE_E1_E2_MAP_GEO_PERF.md` | 984 | Extension trait, CBOR key 11, GeoExtension, PerformanceExtension | ✅ COMPLETE |
| E3-E4 | `ARE_E3_E4_COST_SEMANTIC_REPUTATION.md` | 2,188 | Cost, Semantic, Version, Reputation extensions, attestation, UCAN | ✅ COMPLETE |
| E5-E6 | `ARE_E5_E6_DHT_TESTING.md` | 1,793 | DHT integration, secondary indexing, heartbeats, adaptive TTL, tests | ✅ COMPLETE |

**Dependency order:** E1-E2 → E3-E4 → E5-E6

## Build Order (across all tracks) — ALL COMPLETE ✅

```
Phase 1:  ✅ P2.8 — Streaming + Cancellation
Phase 2:  ✅ TS-1 → TS-2 — CBOR/Crypto + Transport foundation
Phase 3:  ✅ TS-3 + TS-4 — Server + Client API (parallel)
Phase 4:  ✅ TS-5 — Streaming
Phase 5:  ✅ SCG D1-D2 + ARE E1-E2 — Semantic descriptors + Extension map
Phase 6:  ✅ SCG D3-D4 + ARE E3-E4 — Indexing + Cost/Reputation
Phase 7:  ✅ AR T1-T2 + PS P1-P2 — Metrics/Routing + PubSub API
Phase 8:  ✅ AR T3-T4 + PS P3-P4 — Breaker/Hedging + BackChannel
Phase 9:  ✅ AR T5-T7 + PS P5-P6 — Integration + Security/GossipSub
Phase 10: ✅ SCG D5-D6 + ARE E5-E6 — Planning + DHT integration
Phase 11: ✅ TS-6 → TS-7 — Browser + MCP
Phase 12: ✅ TS-8 → TS-9 — Testing + Packaging
```

**Result:** 1864 Rust tests + 151 TypeScript tests = 2015 total, 0 failures.
Security review complete. Freeze tag: `v0.4-intelligence-plane`.

## Cross-Track Dependencies

```
SCG D1-D2 ──→ AR T5-T7 (routing uses semantic scoring)
ARE E1-E2 ──→ ARE E3-E4 ──→ ARE E5-E6
ARE E3-E4 ──→ SCG D5-D6 (planner uses reputation/cost)
PS P1-P2  ──→ PS P3-P4  ──→ PS P5-P6
TS-1      ──→ TS-2      ──→ TS-3 + TS-4 ──→ TS-5
```
