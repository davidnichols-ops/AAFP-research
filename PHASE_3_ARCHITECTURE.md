# Phase 3 Architecture — Ecosystem Building

**Goal:** Make AAFP the easiest thing to build on. Build the ecosystem before
the protocol is "finished." The moat is network effects, not cryptography.

**Duration:** 3-6 months (ongoing)
**Prerequisite:** Phase 2 COMPLETE (developer experience)
**Owner:** David Nichols (arms and legs) + Devin (CEO/architect)

---

## The Strategic Principle

Linux succeeded because thousands of projects could build on it. AAFP must
do the same. The ecosystem should be growing before the protocol stops changing.

**The adoption test:** Can a developer use AAFP without understanding the
protocol? If NO, simplify before adding features.

**The moat test:** Will this feature be a commodity in 5 years? If YES, it's
table stakes. The durable moat is the number of interoperable agents and the
richness of the capability graph.

---

## Architecture: The Agent Operating System

```
┌─────────────────────────────────────────────────────────────┐
│                     APPLICATIONS LAYER                        │
│  MCP agents · A2A agents · Custom agents · Workflows         │
├─────────────────────────────────────────────────────────────┤
│                     ECOSYSTEM LAYER                           │
│  SDKs (Rust/Python/TS) · CLI · Examples · Tutorials · Plugins│
├─────────────────────────────────────────────────────────────┤
│                   INTELLIGENCE LAYER (Phase 4)                │
│  Adaptive Routing · Capability Graphs · Execution Fabric     │
│  Agent Reputation · Economic Layer                            │
├─────────────────────────────────────────────────────────────┤
│                     TRUST LAYER                               │
│  Identity (ML-DSA-65) · UCAN · TrustManager · Key Directory  │
│  Reputation (future) · CA/WoT (done)                          │
├─────────────────────────────────────────────────────────────┤
│                    DISCOVERY LAYER                            │
│  Kademlia DHT · Bootstrap · PEX · Replication · Churn        │
│  Semantic Discovery (future) · Capability Graphs (future)    │
├─────────────────────────────────────────────────────────────┤
│                    TRANSPORT LAYER (FROZEN)                   │
│  QUIC · PQ-TLS · CBOR Framing · NAT Traversal · Relay        │
├─────────────────────────────────────────────────────────────┤
│                    UDP → IP → INTERNET                        │
└─────────────────────────────────────────────────────────────┘
```

**The immutable boundary:** Transport layer is frozen (Rev 6). Everything
above it evolves. Never bake algorithms into the protocol. Bake interfaces.

---

## Phase 3 Components

### 3.1: Multi-Language SDK (Month 1-2)

Three SDKs with identical high-level APIs:

#### Rust SDK (reference — already exists)
```rust
let agent = Agent::serve()
    .capability("translation")
    .handler(|req| async { Ok(Response::text(translate(req.text()))) })
    .start().await?;
```

#### Python SDK (extend existing PyO3 adapter)
```python
from aafp import Agent

agent = Agent.serve(capability="translation")

@agent.handler
async def translate(request):
    return {"text": translate_text(request["text"])}

await agent.start()
```

#### TypeScript SDK (NEW — build from scratch)
```typescript
import { Agent } from "@aafp/sdk";

const agent = Agent.serve()
  .capability("translation")
  .handler(async (req) => ({ text: translate(req.text) }));

await agent.start();
```

**Architecture for TypeScript SDK:**
- Option A: Native Node.js addon via N-API (wraps Rust core)
  - Pro: Full performance, all features
  - Con: Platform-specific builds, complex CI
- Option B: WASM module (compiles Rust to wasm32-wasi)
  - Pro: Runs anywhere (browser, Node, Deno, Bun)
  - Con: No direct QUIC access (WASM doesn't have UDP), needs a transport bridge
- Option C: Pure TypeScript reimplementation of the protocol
  - Pro: Native JS/TS, no native deps, npm install just works
  - Con: Must maintain protocol conformance, PQ crypto in JS is slower
- **Recommended: Option C (pure TS) for v1, Option A (native) for performance**
  - Pure TS for broad compatibility and easy `npm install`
  - Use `@noble/post-quantum` for ML-DSA-65 in JS
  - Use `quic` module (Node 23+ has native QUIC) or WebTransport fallback
  - Native addon as `@aafp/sdk-native` for users who need max performance

**Each SDK must provide:**
- `Agent.serve()` / `Agent.connect()` — high-level API
- `agent.discover(capability)` — discovery
- `agent.call(request)` — RPC
- `agent.stream(handler)` — streaming responses
- `agent.on("event", handler)` — event subscription
- Automatic keypair generation and management
- Automatic NAT traversal and relay selection
- Automatic discovery and bootstrap
- Type-safe request/response (generics in Rust/TS, type hints in Python)
- Error handling with language-native errors (Result/try-except/Promise)

### 3.2: Plugin System (Month 2)

Allow developers to extend AAFP without forking.

**Plugin Architecture:**
```rust
// Rust plugin trait
pub trait AafpPlugin: Send + Sync {
    fn name(&self) -> &str;
    fn on_request(&self, request: &mut Request) -> Result<(), PluginError>;
    fn on_response(&self, response: &mut Response) -> Result<(), PluginError>;
    fn on_connect(&self, peer: &AgentId) -> Result<(), PluginError>;
    fn on_disconnect(&self, peer: &AgentId) -> Result<(), PluginError>;
}

// Register
Agent::serve()
    .capability("translation")
    .plugin(LoggingPlugin::new())
    .plugin(RateLimitPlugin::new(100))
    .plugin(AuthPlugin::new(TrustLevel::Verified))
    .handler(|req| async { ... })
    .start().await?;
```

**Plugin types:**
- **Middleware plugins:** Intercept requests/responses (logging, rate limiting, auth)
- **Capability plugins:** Register new capabilities (OCR, translation, inference)
- **Transport plugins:** Custom transport (WebSocket, WebRTC, Bluetooth)
- **Discovery plugins:** Custom discovery (mDNS, DNS-SD, registry)

**Plugin distribution:**
- Rust: crates.io (`aafp-plugin-*`)
- Python: pip (`aafp-plugin-*`)
- TypeScript: npm (`@aafp/plugin-*`)

### 3.3: Reference Applications (Month 2-3)

5 applications that demonstrate AAFP's value:

#### 1. Multi-Agent Translation Pipeline
```
User → OCR Agent → Translation Agent → Summarization Agent → User
```
- Demonstrates: capability discovery, agent chaining, streaming
- Languages: Rust (OCR), Python (translation via API), Rust (summarization)
- Shows: no hardcoded endpoints, automatic discovery

#### 2. Distributed Inference Network
```
User → Router Agent → [GPU Agent 1, GPU Agent 2, GPU Agent 3] → User
```
- Demonstrates: load balancing, capability-based routing, failover
- Router discovers GPU agents, picks best one, falls back on failure
- Shows: the network gets more capable as more agents join

#### 3. Agent Marketplace
```
Provider Agent → announces capability + price + SLA
Consumer Agent → discovers, negotiates, calls, pays
```
- Demonstrates: reputation, resource accounting, trust
- Web UI showing available agents, their capabilities, performance
- Shows: the economic layer forming organically

#### 4. Collaborative Code Review
```
Developer → Review Agent → [Security Agent, Style Agent, Test Agent] → Report
```
- Demonstrates: multi-agent coordination, UCAN delegation
- Security agent has "security-review" capability, style has "lint", etc.
- Shows: agents collaborating with different trust levels

#### 5. Self-Healing Service Mesh
```
Service A → calls Service B → B dies → A discovers Service C → continues
```
- Demonstrates: churn handling, automatic failover, resilience
- 5 services, kill one, watch the network heal
- Shows: the network is more reliable than any single agent

### 3.4: Developer Tooling (Month 3)

#### `aafp dev` — Development Server
```bash
aafp dev --capability echo --hot-reload
```
- Hot-reload agent on file change
- Auto-generate test requests
- Show real-time metrics in terminal
- Built-in test client

#### `aafp test` — Test Runner
```bash
aafp test --capability echo --input "hello"
```
- Send test requests to a running agent
- Verify responses
- Benchmark latency

#### `aafp debug` — Debug Tool
```bash
aafp debug --trace
```
- Show all AAFP frames being sent/received
- Show DHT lookups, relay connections, NAT status
- Show trust decisions, capability checks
- Like `curl -v` but for AAFP

#### `aafp bench` — Benchmarking
```bash
aafp bench --capability echo --requests 10000
```
- Measure latency (p50, p90, p99)
- Measure throughput
- Compare to baseline

### 3.5: Community Infrastructure (Month 3-4)

#### Public Relay Network
- Deploy 3 relay nodes (US, EU, Asia) on cloud VMs
- Pre-configured in SDK as default relays
- Anyone can use them for NAT traversal
- Funded by the project initially, community-funded later

#### Bootstrap Seed Nodes
- Deploy 5 bootstrap nodes that are always online
- Pre-configured in SDK as default seeds
- New agents connect to seeds, learn about the network
- The seeds don't serve requests, just route DHT lookups

#### Capability Registry (optional)
- A website showing all known capabilities on the network
- `aafp.dev/registry` — browse agents by capability
- Shows: agent count, average latency, trust level
- Not required (DHT is sufficient) but nice for discovery

#### Documentation Site
- `aafp.dev` — developer documentation
- API reference, tutorials, examples, guides
- Community-contributed plugins and agents
- Status page (relay health, seed health, network size)

### 3.6: Interoperability with Existing Ecosystems (Month 4-5)

AAFP doesn't replace existing protocols. It bridges them.

#### MCP Bridge
- AAFP agents can expose MCP endpoints (already done — `aafp-transport-mcp`)
- MCP clients can discover AAFP agents via the DHT
- No changes needed to MCP SDK

#### A2A Bridge
- AAFP agents can participate in A2A workflows (already done — `aafp-transport-a2a`)
- A2A agents can be discovered via AAFP DHT

#### HTTP Gateway
- `aafp gateway` — exposes AAFP agents as HTTP endpoints
- `curl http://localhost:8080/capability/echo -d '{"text":"hello"}'`
- Translates HTTP → AAFP → HTTP
- For integration with non-AAFP systems

#### gRPC Bridge
- `aafp grpc-bridge` — exposes AAFP agents as gRPC services
- For enterprise integration

#### OpenAI-Compatible API
- `aafp openai-bridge` — exposes AAFP agents as OpenAI API endpoints
- `POST /v1/chat/completions` → discover "chat" capability → call agent
- For drop-in replacement of OpenAI API with decentralized agents

### 3.7: Governance and Standards (Month 5-6)

#### RFC Process
- Anyone can propose an RFC via GitHub PR
- RFCs are reviewed by the community
- Wire protocol RFCs require 2/3 consensus (hard to change)
- Intelligence layer RFCs require simple majority (easy to change)

#### Compatibility Testing
- Continuous conformance testing across all 3 SDKs
- Cross-language interop tests in CI
- Golden trace verification (Rust ↔ Go ↔ Python ↔ TypeScript)

#### Version Policy
- Wire protocol: semver with compatibility guarantees (frozen at Rev 6)
- SDKs: semver with breaking changes allowed in major versions
- Intelligence layer: rapid iteration, no compatibility guarantees yet

---

## Success Criteria

- [ ] SDK available in 3 languages (Rust, Python, TypeScript)
- [ ] `npm install @aafp/sdk` works and gives a working agent
- [ ] `pip install aafp` works and gives a working agent
- [ ] 5 reference applications that clone-and-run
- [ ] Plugin system with 3+ community plugins
- [ ] `aafp dev`, `aafp test`, `aafp debug`, `aafp bench` CLI tools
- [ ] Public relay network (3 nodes, US/EU/Asia)
- [ ] Bootstrap seed nodes (5 nodes, always online)
- [ ] Documentation site at aafp.dev
- [ ] HTTP gateway for non-AAFP integration
- [ ] OpenAI-compatible API bridge
- [ ] 100+ agents running on the network (not just our tests)
- [ ] At least 1 third-party developer building on AAFP

---

## The Network Effect Flywheel

```
More agents join
    ↓
Discovery becomes more useful
    ↓
More developers build agents
    ↓
More capabilities available
    ↓
More users find value
    ↓
More agents join
    ↓
(repeat)
```

This is the flywheel that creates the durable moat. Every Phase 3 deliverable
should feed this flywheel. If a deliverable doesn't increase the number of
agents, developers, or capabilities, it's not a priority.

---

## What NOT to Build in Phase 3

- **Storage systems** — leave to ScyllaDB, FoundationDB, S3
- **Databases** — leave to PostgreSQL, MongoDB, Redis
- **Inference engines** — leave to vLLM, TGI, TensorRT-LLM
- **Model formats** — leave to GGUF, SafeTensors, ONNX
- **Vector databases** — leave to Pinecone, Weaviate, Qdrant
- **Blockchain/cryptocurrency** — use resource accounting, not tokens
- **Kubernetes for agents** — AAFP manages capabilities, not machines

**Be the glue.** AAFP connects agents. It doesn't do their jobs for them.

---

## Dependency on Phase 4 (Adaptive Routing)

Phase 3 can proceed without Phase 4. But Phase 4 features will make Phase 3
more compelling:

- **Adaptive Routing** (Phase 4 Track T) → agents share resource metrics →
  discovery can optimize for latency/cost/trust → reference apps become smarter
- **Semantic Discovery** (Phase 4 Track U) → capability graphs →
  "I need OCR + English + <40ms + GPU" instead of just "ocr" →
  more precise agent matching
- **Agent Reputation** (Phase 4 Track W) → performance history →
  developers can trust agents they've never seen before →
  marketplace becomes viable

**Recommended:** Start Phase 3 immediately. Begin Phase 4 Track T (Adaptive
Routing) in parallel once the TypeScript SDK is shipped (Month 2).
