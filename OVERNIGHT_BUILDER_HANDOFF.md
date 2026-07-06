# Overnight Builder Handoff — AAFP Implementation

**Created:** 2026-07-05
**Purpose:** Handoff document for a Devin builder session to implement all 21 builder prompts
**Codebase:** /Users/david/Projects/AAFP-research/implementations/rust/

---

## Mission

Work through all 21 builder prompts in dependency order, implementing each one in the AAFP codebase. After each implementation, run the full test suite to verify no regressions. Commit after each successful phase.

## Current State

- **1718 tests passing**, 0 failures, 7 ignored
- **17 Rust crates**, ~76K lines
- **P2.1-P2.8 complete** (Simple API v2 foundation + streaming + cancellation + connection pooling)
- All 8 research documents complete (~11K lines)
- 21 builder prompts ready (~26K lines of detailed implementation guidance)

## Build Order (STRICT — follow this order)

### Phase 1: TypeScript SDK Foundation (TS-1 → TS-2)
1. **TS-1:** `builder-prompts/TS_PHASE_1_CBOR_CRYPTO.md` — Pure-TS CBOR, ML-DSA-65, HKDF, AEAD, AgentId
2. **TS-2:** `builder-prompts/TS_PHASE_2_TRANSPORT.md` — Transport interface, Node QUIC, WebTransport, WebSocket, frames

### Phase 2: TypeScript SDK API (TS-3 + TS-4 in parallel)
3. **TS-3:** `builder-prompts/TS_PHASE_3_SERVER.md` — ServeBuilder, onCapability, HandlerContext, HandlerError, handshake
4. **TS-4:** `builder-prompts/TS_PHASE_4_CLIENT.md` — ConnectBuilder, ConnectedAgent, DiscoveryBuilder, ConnectionPool

### Phase 3: TypeScript SDK Streaming (TS-5)
5. **TS-5:** `builder-prompts/TS_PHASE_5_STREAMING.md` — StreamingHandlerContext, ResponseStream, onStreaming, callStreaming

### Phase 4: Semantic + AgentRecord (parallel)
6. **SCG D1-D2:** `builder-prompts/SCG_D1_D2_DESCRIPTOR_QUERY.md` — SemanticCapability, CBOR encoding, CapabilityQuery, QueryFilter
7. **ARE E1-E2:** `builder-prompts/ARE_E1_E2_MAP_GEO_PERF.md` — Extension trait, CBOR key 11, GeoExtension, PerformanceExtension

### Phase 5: Semantic + AgentRecord (parallel)
8. **SCG D3-D4:** `builder-prompts/SCG_D3_D4_INDEX_COMPOSE.md` — CapabilityIndex, CapabilityGraph, PipelineAssembler, topological sort
9. **ARE E3-E4:** `builder-prompts/ARE_E3_E4_COST_SEMANTIC_REPUTATION.md` — Cost, Semantic, Version, Reputation extensions, attestation, UCAN

### Phase 6: Routing + PubSub (parallel)
10. **AR T1-T2:** `builder-prompts/AR_T1_T2_METRICS_ROUTING.md` — PeerMetricsRegistry, EWMA, RollingWindow, 4 selection strategies
11. **PS P1-P2:** `builder-prompts/PS_P1_P2_API_PROPAGATION.md` — Simple API, Event, SubscriptionStream, propagation driver fix

### Phase 7: Routing + PubSub (parallel)
12. **AR T3-T4:** `builder-prompts/AR_T3_T4_BREAKER_HEDGING.md` — CircuitBreaker (3-state), bulkhead, request hedging, retry+backoff
13. **PS P3-P4:** `builder-prompts/PS_P3_P4_BACKCHANNEL_ROUTING.md` — Back-channel topics, MQTT wildcards, TopicMatcher, streaming integration

### Phase 8: Routing + PubSub (parallel)
14. **AR T5-T7:** `builder-prompts/AR_T5_T7_INTEGRATION_API.md` — Track U integration, RoutingConfig, per-call overrides, observability
15. **PS P5-P6:** `builder-prompts/PS_P5_P6_SECURITY_GOSSIPSUB.md` — UCAN ACLs, per-connection limits, GossipSub v1.1, peer scoring

### Phase 9: Semantic + AgentRecord (parallel)
16. **SCG D5-D6:** `builder-prompts/SCG_D5_D6_PLAN_BRIDGE.md` — CapabilityPlanner, heuristic+A* search, 11 internet bridge capabilities
17. **ARE E5-E6:** `builder-prompts/ARE_E5_E6_DHT_TESTING.md` — DHT integration, secondary indexing, heartbeats, adaptive TTL, tests

### Phase 10: TypeScript SDK Browser + MCP (TS-6 → TS-7)
18. **TS-6:** `builder-prompts/TS_PHASE_6_BROWSER.md` — WebTransport, WebSocket bridge, isomorphic API, React/Vue/Svelte
19. **TS-7:** `builder-prompts/TS_PHASE_7_MCP.md` — MCP TS SDK wrapping, LangChain.js, Vercel AI SDK integration

### Phase 11: TypeScript SDK Testing + Packaging (TS-8 → TS-9)
20. **TS-8:** `builder-prompts/TS_PHASE_8_TESTING.md` — Vitest, cross-language vectors, conformance, golden traces, CI
21. **TS-9:** `builder-prompts/TS_PHASE_9_PACKAGING.md` — npm monorepo, ESM/CJS, Deno/Bun, TypeDoc, publishing workflow

## Cross-Track Dependencies (MUST respect)

```
TS-1 → TS-2 → (TS-3, TS-4 parallel) → TS-5 → TS-6 → TS-7 → TS-8 → TS-9
SCG D1-D2 → SCG D3-D4 → SCG D5-D6
ARE E1-E2 → ARE E3-E4 → ARE E5-E6
AR T1-T2 → AR T3-T4 → AR T5-T7 (T5-T7 also depends on SCG D1-D2)
PS P1-P2 → PS P3-P4 → PS P5-P6
ARE E3-E4 → SCG D5-D6 (planner uses reputation/cost)
```

## Verification Protocol (AFTER EACH PHASE)

```bash
cd /Users/david/Projects/AAFP-research/implementations/rust

# 1. Format check
cargo fmt --all -- --check

# 2. Build (0 warnings expected)
cargo build --workspace

# 3. Clippy (0 warnings expected)
cargo clippy --workspace -- -D warnings

# 4. Full test suite (must not regress below 1718 tests)
cargo test --workspace

# 5. If all pass, commit
git add -A
git commit -m "$(cat <<'EOF'
Phase X: <description of what was built>

- <key changes>
- Tests: <new count> passing, 0 failures

Generated with [Devin](https://devin.ai)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>
EOF
)"
```

## Key Conventions (from AGENTS.md)

- **v1 types are primary**: `rpc_v1`, `handshake_v1`, `identity_v1` are RFC-compliant exports
- **Legacy modules** (`rpc`, `handshake`, `agent_record`) are `#[deprecated]` — don't use them
- **Session enforcement**: All SDK messaging requires a completed v1 handshake
- **Conformance crate**: Uses `#![allow(unused_imports, dead_code)]`
- **No new dependencies** without checking neighboring files first
- **Don't add/remove comments** unless asked
- **Compact code** — collapse duplicate else branches, avoid unnecessary nesting

## TypeScript SDK Location

The TypeScript SDK should be created at:
```
/Users/david/Projects/AAFP-research/implementations/typescript/
```

Follow the monorepo structure described in TS_PHASE_9_PACKAGING.md from the start.

## Rust Implementation Location

All Rust changes go in:
```
/Users/david/Projects/AAFP-research/implementations/rust/crates/
```

## Research Documents (read these before implementing each track)

| Track | Research Document | Builder Prompts |
|-------|------------------|-----------------|
| TypeScript SDK | `TYPESCRIPT_SDK_DESIGN.md` | TS_PHASE_1-9 |
| Semantic Capability Graphs | `SEMANTIC_CAPABILITY_GRAPHS.md` | SCG_D1-D6 |
| Adaptive Routing | `ADAPTIVE_ROUTING_PLANE.md` | AR_T1-T7 |
| PubSub + Back-Channel | `PUBSUB_BACKCHANNEL_DESIGN.md` | PS_P1-P6 |
| AgentRecord Extensions | `AGENT_RECORD_EXTENSIONS.md` | ARE_E1-E6 |

## Error Recovery

If a phase fails:
1. Read the error messages carefully
2. Check the builder prompt for guidance on edge cases
3. Search the codebase for similar patterns
4. Fix and re-run tests
5. If stuck after 3 attempts, skip to the next independent phase and come back

## Progress Tracking

After each phase, update this file with:
- [x] Phase N: <name> — COMPLETE (<test count> tests)
- [ ] Phase N+1: <name> — NEXT

## Final Deliverable

At the end, all 21 builder prompts should be implemented, with:
- TypeScript SDK at `implementations/typescript/`
- All Rust crates updated with new features
- Full test suite passing with no regressions
- Each phase committed separately with clear messages
