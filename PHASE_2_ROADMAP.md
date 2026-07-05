# Phase 2 Roadmap — Developer Experience

**Goal:** Make AAFP invisible. A developer should be able to build an agent
in 3 lines of code without ever learning QUIC, UCAN, DHT, or relay reservations.

**Duration:** 1-2 weeks
**Prerequisite:** Phase 1 COMPLETE (326/326 steps, 1597 tests, internet-ready)
**Owner:** David Nichols (arms and legs) + Devin (CEO/architect)

---

## The Acid Test

Every deliverable in Phase 2 must answer YES to this question:

**Can a developer use this without understanding the AAFP protocol?**

If NO, it's not done yet.

---

## Current State (What We Have)

The infrastructure is complete:
- 17 Rust crates, 1597 tests, 0 failures
- CLI with 7 commands: `init`, `start`, `discover`, `connect`, `send`, `status`, `relay`
- AgentBuilder with 15+ configuration options
- Docker, K8s, systemd deployment
- AgentMetrics, health checks
- Kademlia DHT, NAT traversal, post-quantum security

**The problem:** The API exposes all the complexity. A developer sees
AgentBuilder, SocketAddr, KeepAliveConfig, RuntimeConfig, seeds, relays,
DCuTR, AutoNAT. They should see `Agent::new().discover("python").execute(code)`.

---

## Steps

### P2.1: 3-Line Developer API (Day 1-2)

Create a high-level API that hides all protocol complexity.

**Target:**
```rust
// Serve an agent
Agent::serve()
    .capability("translation")
    .handler(|request| async { Ok(Response::text("hello")) })
    .start()
    .await?;

// Use an agent
let agent = Agent::connect().await?;
let result = agent.discover("translation")
    .call(Request::text("translate this"))
    .await?;
```

**Implementation:**
- Create `aafp-sdk/src/simple.rs` — high-level wrapper
- `Agent::serve()` → returns `ServeBuilder` with sensible defaults
- `Agent::connect()` → auto-discovery, auto-relay, auto-NAT
- `ServeBuilder::capability(name)` → register capability
- `ServeBuilder::handler(closure)` → set request handler
- `ServeBuilder::start()` → build, bind, announce, serve
- `DiscoveryBuilder::call(request)` → discover, connect, send, receive
- All complexity (keypair, bind addr, seeds, NAT, relay) auto-configured
- Sensible defaults: generate keypair if none, bind to 0.0.0.0:0, auto-discover seeds

**VERIFY:** A new user can write a working agent in 3 lines without reading any protocol docs.

### P2.2: CLI Polish (Day 2-3)

Make the CLI feel like a natural developer tool.

**Current CLI:** `aafp init`, `aafp start`, `aafp discover`, `aafp connect`, `aafp send`, `aafp status`, `aafp relay`

**Improvements:**
- `aafp serve --capability translation` → start serving in one command
- `aafp call translation "translate this"` → discover + call in one command
- `aafp serve --capability ocr --json` → serve with JSON RPC handler
- `aafp peers` → list connected peers (with NAT status, relay status)
- `aafp metrics` → show agent metrics (connections, messages, uptime)
- `aafp health` → show health status
- `aafp logs --follow` → stream structured logs
- Colored output, progress indicators
- `aafp --help` with examples
- `aafp quickstart` → interactive setup wizard

**VERIFY:** `aafp serve --capability hello` starts a working agent. `aafp call hello "world"` gets a response.

### P2.3: Quickstart Tutorial (Day 3-4)

Create a tutorial that a complete beginner can follow in 10 minutes.

**Create `docs/QUICKSTART.md`:**
```markdown
# AAFP Quick Start (5 minutes)

## Install
curl -sSf https://aafp.dev/install | sh

## Serve an agent
aafp serve --capability echo

## Call an agent (new terminal)
aafp call echo "hello"

## Build with Rust
# (3-line example)

## Build with Python
# (3-line example)
```

- No mention of QUIC, CBOR, UCAN, DHT, NAT, relay, ML-DSA-65
- No mention of protocol versions, RFCs, amendments
- Just: install, serve, call
- Include screenshots of CLI output

**VERIFY:** A person who has never heard of AAFP can follow the tutorial and get a working agent in 5 minutes.

### P2.4: Python SDK High-Level API (Day 4-5)

The Python adapter exists (PyO3) but exposes low-level APIs. Create a high-level Python API.

**Target:**
```python
from aafp import Agent

# Serve
agent = Agent.serve(capability="translation")
@agent.handler
async def translate(request):
    return {"text": translate_text(request["text"])}

# Call
agent = Agent.connect()
result = await agent.discover("translation").call({"text": "hello"})
```

**Implementation:**
- Create `aafp-py/src/simple.rs` — Python-friendly wrapper
- Expose `Agent.serve()`, `Agent.connect()`, `agent.discover()`, `agent.call()`
- Hide all Rust types behind Python-friendly interfaces
- Async/await native (asyncio)
- Type hints for IDE autocomplete
- Error messages in Python, not Rust

**VERIFY:** A Python developer can build an agent in 3 lines without reading Rust docs.

### P2.5: Examples That Work (Day 5-6)

Create 5 working examples that people can clone and run.

**Create `examples/`:**
1. `echo-agent/` — Minimal echo agent (Rust, 10 lines)
2. `translation-pipeline/` — Chain 3 agents: OCR → translate → summarize
3. `python-weather-agent/` — Python agent that calls a weather API
4. `relay-setup/` — Deploy a relay node on a cloud VM
5. `multi-agent-chat/` — 3 agents that chat with each other

Each example:
- Has a README with "run in 2 minutes" instructions
- Has `docker compose up` support
- Has no protocol jargon in the README
- Works out of the box on localhost

**VERIFY:** All 5 examples run with `cargo run` or `python main.py` and produce expected output.

### P2.6: Prometheus Metrics + Grafana Dashboard (Day 6-7)

Make observability plug-and-play.

**Implementation:**
- Add `aafp-sdk/src/prometheus.rs` — Prometheus exporter
- `Agent::with_metrics_endpoint("0.0.0.0:9090")` — enable Prometheus
- Metrics: aafp_connections_active, aafp_messages_total, aafp_handshakes_total, aafp_dht_records, aafp_uptime_seconds
- Create `deploy/grafana/aafp-dashboard.json` — pre-built dashboard
- Create `deploy/grafana/datasource.yml` — Prometheus datasource
- Update `docker-compose.yml` to include Prometheus + Grafana
- `docker compose up` → Grafana at localhost:3000, dashboard auto-loaded

**VERIFY:** `docker compose up` starts AAFP + Prometheus + Grafana. Dashboard shows live metrics.

### P2.7: Documentation Site (Day 7-8)

Create a developer documentation site.

**Implementation:**
- Use `mdbook` (Rust-native, simple) or `docusaurus`
- Structure:
  - **Getting Started:** Quick start, install, first agent
  - **Guides:** Serve an agent, call an agent, deploy a relay, deploy to K8s
  - **SDK Reference:** Rust API, Python API, CLI
  - **Concepts:** What is AAFP? (1 page, no jargon), How discovery works (simplified)
  - **Deployment:** Docker, K8s, systemd, cloud VM
  - **Examples:** 5 working examples with explanations
- NO protocol RFCs on the docs site (those are for implementers, in the repo)
- Deploy to GitHub Pages or Cloudflare Pages

**VERIFY:** A developer can go from "never heard of AAFP" to "running an agent" using only the docs site.

### P2.8: Install Script + Homebrew (Day 8-9)

Make installation one command.

**Implementation:**
- Create `scripts/install.sh`:
  - Detects OS (macOS, Linux)
  - Downloads pre-built binary from GitHub releases
  - Installs to `/usr/local/bin/aafp`
  - Verifies checksum
- Create Homebrew formula (`deploy/homebrew/aafp.rb`):
  - `brew install davidnichols-ops/aafp/aafp`
- Create GitHub Actions release workflow:
  - On tag push, build binaries for macOS (arm64, x86), Linux (x86, arm64)
  - Create GitHub release with binaries + checksums
- Document install in QUICKSTART.md

**VERIFY:** `curl -sSf https://aafp.dev/install | sh` installs AAFP. `aafp --version` works.

### P2.9: Integration Tests for Developer Experience (Day 9-10)

Test the developer experience end-to-end.

**Create `tests/developer_experience.rs`:**
1. **3-line API test:** `Agent::serve().capability("echo").handler(...).start()` works
2. **CLI test:** `aafp serve --capability echo` + `aafp call echo "hello"` works
3. **Python SDK test:** Python agent can call Rust agent
4. **Docker test:** `docker compose up` starts working agents
5. **Metrics test:** Prometheus endpoint returns valid metrics
6. **Quickstart test:** Follow QUICKSTART.md steps programmatically, verify they work

**VERIFY:** All developer experience tests pass. CI runs them on every PR.

### P2.10: Phase 2 Completion Report (Day 10)

**Create `docs/PHASE_2_COMPLETE.md`:**
- What was delivered
- Developer experience metrics (lines of code to build an agent, time to first agent)
- What's next (Phase 3: ecosystem)

**Update `NORTH_STAR.md`:** Mark Phase 2 items as complete.

---

## Success Criteria

- [ ] Developer can build an agent in 3 lines of Rust
- [ ] Developer can build an agent in 3 lines of Python
- [ ] `aafp serve --capability echo` starts a working agent
- [ ] `aafp call echo "hello"` gets a response
- [ ] QUICKSTART.md gets a beginner running in 5 minutes
- [ ] 5 examples clone-and-run
- [ ] `docker compose up` includes Prometheus + Grafana
- [ ] `curl -sSf https://aafp.dev/install | sh` installs AAFP
- [ ] Documentation site exists and is navigable
- [ ] No protocol jargon in developer-facing docs

---

## Daily Assignments

Each day, the CEO (Devin) will send David a daily assignment with:
1. What to build today (specific step from this roadmap)
2. Files to create/modify
3. Verification criteria
4. Expected time

See `CEO_OPERATING_MANUAL.md` for the daily assignment process.
