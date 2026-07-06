# Builder Handoff — AAFP Intelligence Plane Implementation — COMPLETE ✅

**Created:** 2026-07-05 (updated 2026-07-06)
**Purpose:** Handoff document for implementing the 15 Intelligence Plane builder prompts — **ALL IMPLEMENTED**
**Codebase:** /Users/david/Projects/AAFP-research/implementations/rust/

---

## Mission — COMPLETE ✅

All 15 builder prompts across 4 tracks have been implemented to build the
Intelligence Plane — the 85% of the system above transport. The TypeScript SDK
(9 prompts) was already complete. These 15 prompts built the semantic,
routing, pubsub, and extension layers.

## Current State

- **1864 Rust tests passing**, 0 failures, 7 ignored
- **151 TypeScript tests passing**, 0 errors (ALL 9 TS PHASES COMPLETE)
- **2015 total tests** across Rust + TypeScript
- **17 Rust crates**, ~115K lines
- **7 TypeScript packages**, ~9.9K lines
- **P2.1-P2.8 complete** (Simple API v2 + streaming + cancellation + pooling)
- All 8 research documents complete (~12.8K lines)
- **All 15 builder prompts IMPLEMENTED** (~15K lines of new code)
- Security review complete (4 critical + 12 high findings fixed)
- 0 clippy warnings
- Freeze tag: `v0.4-intelligence-plane`

## The 4 Tracks (parallel, independent)

### Track 1: Semantic Capability Graphs (SCG D1-D6)
**Target:** `crates/aafp-discovery/src/semantic/` (13 stub files)
**Prompts:**
- `SCG_D1_D2_DESCRIPTOR_QUERY.md` (1,081 lines) — SemanticCapability, CBOR encoding, CapabilityQuery
- `SCG_D3_D4_INDEX_COMPOSE.md` (700 lines) — CapabilityIndex, CapabilityGraph, PipelineAssembler
- `SCG_D5_D6_PLAN_BRIDGE.md` (1,140 lines) — CapabilityPlanner, A* search, 11 bridge capabilities
**Order:** D1-D2 → D3-D4 → D5-D6 (sequential)

### Track 2: AgentRecord Extensions (ARE E1-E6)
**Target:** `crates/aafp-identity/src/extensions/` (10 stub files)
**Prompts:**
- `ARE_E1_E2_MAP_GEO_PERF.md` (984 lines) — Extension trait, CBOR key 11, Geo, Performance
- `ARE_E3_E4_COST_SEMANTIC_REPUTATION.md` (2,188 lines) — Cost, Semantic, Version, Reputation, attestation
- `ARE_E5_E6_DHT_TESTING.md` (1,793 lines) — DHT integration, secondary indexing, heartbeats, tests
**Order:** E1-E2 → E3-E4 → E5-E6 (sequential)

### Track 3: Adaptive Routing Plane (AR T1-T7)
**Target:** `crates/aafp-sdk/src/routing/` (11 stub files)
**Prompts:**
- `AR_T1_T2_METRICS_ROUTING.md` (1,416 lines) — PeerMetricsRegistry, EWMA, 4 selection strategies
- `AR_T3_T4_BREAKER_HEDGING.md` (1,129 lines) — CircuitBreaker, bulkhead, hedging, retry+backoff
- `AR_T5_T7_INTEGRATION_API.md` (986 lines) — Integration, RoutingConfig, per-call overrides, observability
**Order:** T1-T2 → T3-T4 → T5-T7 (sequential)
**Note:** T5-T7 depends on SCG D1-D2 (uses SemanticCapability)

### Track 4: PubSub + Back-Channeling (PS P1-P6)
**Target:** `crates/aafp-sdk/src/pubsub/` (13 stub files)
**Prompts:**
- `PS_P1_P2_API_PROPAGATION.md` (1,673 lines) — Simple API, Event, SubscriptionStream, propagation
- `PS_P3_P4_BACKCHANNEL_ROUTING.md` (1,203 lines) — Back-channel topics, MQTT wildcards, TopicMatcher
- `PS_P5_P6_SECURITY_GOSSIPSUB.md` (866 lines) — UCAN ACLs, limits, GossipSub v1.1, peer scoring
**Order:** P1-P2 → P3-P4 → P5-P6 (sequential)

## Cross-Track Dependencies

```
SCG D1-D2 → SCG D3-D4 → SCG D5-D6
ARE E1-E2 → ARE E3-E4 → ARE E5-E6
AR T1-T2 → AR T3-T4 → AR T5-T7 (T5-T7 also needs SCG D1-D2)
PS P1-P2 → PS P3-P4 → PS P5-P6
ARE E3-E4 → SCG D5-D6 (planner uses reputation/cost)
```

**Parallelization:** Tracks 1-4 can run in parallel. Within each track, phases are sequential.

## Verification Protocol (AFTER EACH PHASE)

```bash
cd /Users/david/Projects/AAFP-research/implementations/rust

# 1. Format check
cargo fmt --all -- --check

# 2. Build (0 warnings expected)
cargo build --workspace

# 3. Clippy (0 warnings expected)
cargo clippy --workspace -- -D warnings

# 4. Full test suite (must not regress below 1864 tests)
cargo test --workspace

# 5. If all pass, commit
git add -A
git commit -m "Phase X: <description>

- <key changes>
- Tests: <new count> passing, 0 failures

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>"
```

## Key Conventions (from AGENTS.md)

- **v1 types are primary**: `rpc_v1`, `handshake_v1`, `identity_v1` are RFC-compliant exports
- **Legacy modules** (`rpc`, `handshake`, `agent_record`) are `#[deprecated]` — don't use them
- **Session enforcement**: All SDK messaging requires a completed v1 handshake
- **Conformance crate**: Uses `#![allow(unused_imports, dead_code)]`
- **No new dependencies** without checking neighboring files first
- **Don't add/remove comments** unless asked
- **Compact code** — collapse duplicate else branches, avoid unnecessary nesting

## Strategic Context

Transport is 15% of the system. The Intelligence Plane is the other 85%.
These 15 prompts build the foundation of that plane:

1. **Predictive Routing** (AR) — gossip metrics, temporal routing, circuit breaker, hedging
2. **Intent Routing** (SCG) — semantic discovery, pipeline assembly, planning
3. **Agent Reputation** (ARE) — performance history as identity, 25+ AgentRecord fields
4. **PubSub** (PS) — event streaming, back-channeling, GossipSub v1.1, UCAN security

Every new agent should make every other agent more useful. That is the
exponential network effect that makes AAFP impossible to replace.

See `INTELLIGENCE_PLANE.md` for the full strategic design.
