# AAFP Developer Experience & Documentation Plan

**Status:** Proposed
**Audience:** Protocol maintainers, SDK authors, DevRel, tooling engineers
**Goal:** Make AAFP the most pleasant agent framework to learn, build, debug,
and operate — measured against gRPC, tRPC, and LangChain.

AAFP v1 is internet-ready: 326 steps complete, 2857 tests passing, the wire
protocol frozen at Rev 6. Phase 2 is **developer experience**. This document
is the master plan for that phase. It covers documentation architecture,
learning paths, an interactive playground, SDK onboarding in three languages,
error-message design, debugging tooling, IDE support, CLI improvements,
templates, an example gallery, community process, developer-survey design,
and a competitive comparison.

The north-star principle for every section below:

> **A developer who has never heard of AAFP should have a working agent
> responding to messages in under five minutes, and should never have to read
> an RFC to ship to production.**

---

## Table of Contents

1. [Principles](#1-principles)
2. [Documentation Site Architecture](#2-documentation-site-architecture)
3. [Learning Path](#3-learning-path)
4. [Interactive Playground](#4-interactive-playground)
5. [SDK Onboarding by Language](#5-sdk-onboarding-by-language)
6. [Error Message Design](#6-error-message-design)
7. [Debugging Tools](#7-debugging-tools)
8. [IDE Support](#8-ide-support)
9. [CLI Improvements](#9-cli-improvements)
10. [Template Repository](#10-template-repository)
11. [Example Gallery](#11-example-gallery)
12. [Community Documentation](#12-community-documentation)
13. [Developer Survey Design](#13-developer-survey-design)
14. [Competitive Comparison](#14-competitive-comparison)
15. [Implementation Roadmap](#15-implementation-roadmap)
16. [Success Metrics](#16-success-metrics)

---

## 1. Principles

These principles govern every DX decision. When a proposal conflicts with one,
the principle wins.

1. **Time-to-first-message under 5 minutes.** Measured from `git clone` to a
   successful `aafp call` response. This is the single most important metric.
2. **No RFC required to ship.** RFCs are the spec, not the manual. The docs
   site is the manual. RFCs are linked from the manual for readers who want
   depth, but never required for a working agent.
3. **Every error teaches.** No bare error codes. Every error message names the
   problem, names the likely cause, and names the fix — with a copy-pasteable
   command where possible.
4. **Batteries included, escape hatches visible.** The 3-line API covers 80%
   of agents. The full protocol surface is one click away for the 20% who need
   it. Never hide power; never force it on beginners.
5. **One tool, one job.** The CLI, the SDK, the IDE extension, and the
   playground each have a clear scope. No overlapping responsibilities that
   confuse users about which to reach for.
6. **Examples are runnable, not illustrative.** Every code block in the docs
   is extracted from a file that compiles and runs in CI. Broken examples fail
   the build.
7. **Measure, then iterate.** Every DX surface has an instrumented funnel. We
   know where developers drop off because we measure it, not because we guess.

---

## 2. Documentation Site Architecture

### 2.1 Static-site generator: Docusaurus

**Decision:** Docusaurus (not mdBook).

**Rationale:**

| Criterion | mdBook | Docusaurus |
|-----------|--------|------------|
| Audience | Rust internals readers | Polyglot developers (Rust/Python/TS) |
| Multi-language tabs | Manual | Built-in (`<Tabs>`) |
| Versioned docs | Manual | Built-in |
| Search | Basic | Algolia / local index |
| i18n | Manual | Built-in |
| Plugin ecosystem | Thin | Rich (redoc, openapi, mermaid) |
| Branding/theming | Limited | Full React theming |
| Maintenance burden | Low | Medium |

AAFP targets three language ecosystems (Rust, Python, TypeScript). The single
most valuable doc feature is **language-switcher tabs** — the same concept page
showing Rust, Python, and TS side by side. Docusaurus does this natively with
`@theme/Tabs`. mdBook requires hand-rolled JavaScript.

The cost is a Node toolchain for the docs site. That is acceptable because the
docs site is built in CI and deployed to GitHub Pages; contributors rarely run
it locally. A `make docs` target wraps the Node commands so contributors never
touch `npm` directly.

### 2.2 Site structure

```
docs-site/
├── docusaurus.config.ts
├── sidebars.ts
├── src/
│   ├── pages/
│   │   ├── index.tsx              Landing page (hero, 5-min CTA)
│   │   ├── playground.tsx         Embedded playground (Section 4)
│   │   └── comparison.tsx         AAFP vs gRPC/tRPC/LangChain table
│   ├── components/
│   │   ├── AgentExplorer.tsx      Sidebar agent-graph visualizer
│   │   ├── FrameInspector.tsx     CBOR frame hex viewer
│   │   └── CapabilityBadge.tsx
│   └── theme/
│       └── Tabs/                  Custom language-tab component
├── docs/
│   ├── 01-quickstart/             5-minute quickstart (mirrors QUICKSTART.md)
│   ├── 02-tutorial/               30-minute tutorial
│   ├── 03-concepts/               Agent, Capability, Frame, Discovery
│   ├── 04-deep-dive/              2-hour deep dive (transport, crypto, DHT)
│   ├── 05-sdk/                    Per-language SDK reference
│   │   ├── rust/
│   │   ├── python/
│   │   └── typescript/
│   ├── 06-cli/                    aafp CLI man pages
│   ├── 07-deployment/             Docker, K8s, systemd (from existing docs/)
│   ├── 08-operations/             Runbook, metrics, troubleshooting
│   ├── 09-rfcs/                   Rendered RFCs (frozen, Rev 6)
│   └── 10-community/              Contributing, RFC process, governance
├── api/                           Auto-generated API reference (Section 2.3)
├── examples/                      Example gallery (Section 11)
└── versioned_docs/                Snapshot per release
```

### 2.3 API reference generation

Each language gets its native doc tool, piped into Docusaurus.

| Language | Generator | Output | Integration |
|----------|-----------|--------|-------------|
| Rust | `cargo doc` + `cargo doc --output-format json` | HTML + JSON | `docusaurus-plugin-rust-docs` (custom) embeds `cargo doc` HTML in an iframe page; JSON feeds a searchable index |
| Python | `pdoc` (or `mkdocstrings` if we move to MkDocs later) | HTML | Copied into `docs/05-sdk/python/api/` at build time |
| TypeScript | `TypeDoc` | HTML | Copied into `docs/05-sdk/typescript/api/` |

**Why not a single unified API browser?** Because developers read API docs in
the idiom of their language. A Rust developer expects `cargo doc` styling and
cross-links to trait definitions. A Python developer expects `pdoc`'s
signature rendering. Forcing one style onto all three creates friction. The
cost is three pipelines; the benefit is native-feeling reference docs in each
language.

**Search:** A unified Algolia DocSearch index spans the prose docs and all
three API references. A search for `Agent::serve` returns the Rust doc page;
a search for `agent.serve()` returns the Python page. Language is inferred
from the query syntax when possible.

### 2.4 Doc-tests are CI gates

Every fenced code block in `docs/` is tagged with a language and an example
file path:

````markdown
```rust file=examples/quickstart/serve.rs
aafp_sdk::simple::Agent::serve()
    .capability("greet")
    .handler(|req| async move { Ok(Response::text("hi")) })
    .start().await
```
````

A CI job (`make docs-check`) extracts these blocks, writes them to the named
files, and compiles/runs them. If a code block doesn't compile, CI fails.
This guarantees the docs never drift from the code. The extraction tool is a
200-line Rust binary in `tools/extract-doc-examples`.

### 2.5 Versioning

Docusaurus built-in versioning. Each release tag snapshots `docs/` into
`versioned_docs/vX.Y.Z/`. The site shows a version dropdown. The `current`
branch always reflects the main branch. RFCs are frozen at Rev 6 and live in
`docs/09-rfcs/` with a banner: "Frozen — changes require a new RFC."

### 2.6 Build and deploy

```yaml
# .github/workflows/docs.yml
- Build Rust docs (cargo doc)
- Build Python docs (pdoc)
- Build TS docs (typedoc)
- Build Docusaurus (npm run build)
- Deploy to GitHub Pages (actions/deploy-pages@v4)
```

Target: `https://aafp.dev` (or `https://davidnichols-ops.github.io/AAFP-research`
until a domain is acquired). Build time budget: under 3 minutes.

---

## 3. Learning Path

The learning path is a funnel. Each stage has a target completion time, a
target completion rate, and an exit criterion. Drop-off between stages is
measured (Section 13).

### Stage 1: 5-Minute Quickstart

**Goal:** First successful `aafp call` response.

**Content:** Mirrors the existing `docs/QUICKSTART.md` — install, serve, call,
build-your-own, Docker. The web version adds:
- Copy buttons on every command.
- Expected-output blocks that the reader can visually match.
- A "something went wrong?" accordion under each step linking to the
  troubleshooting page for that specific failure.

**Exit criterion:** Reader runs `aafp call greet "World"` and sees
`Hello, World!`.

**Target completion rate:** 85% of readers who start the quickstart finish
it. Measured by a "Did this work?" thumbs-up/down widget at the bottom.

### Stage 2: 30-Minute Tutorial

**Goal:** Build a multi-agent workflow (translation pipeline) from scratch.

**Content:** A single linear narrative that introduces concepts just-in-time:

1. **Two agents, one relay** (5 min) — Start a relay, start two agents, watch
   them discover each other via `aafp peers`.
2. **Capabilities and routing** (5 min) — Add a `translate` capability to one
   agent, call it from the other using capability-based routing (no hardcoded
   address).
3. **Streaming responses** (5 min) — Convert the translate agent to stream
   tokens as they arrive. See them arrive in the CLI.
4. **Error handling** (5 min) — Make the translate agent fail on empty input.
   Observe the structured error frame. Handle it in the caller.
5. **Identity and trust** (5 min) — Pin a trusted agent ID. Call an untrusted
   agent. See the authorization failure. Add a UCAN capability delegation.
6. **Deploy with Docker** (5 min) — `docker compose up` the three-agent setup.
   Inspect logs. Scale to 5 agents.

**Format:** Each step is a page with code the reader types (not copies) into
their own project. A `tutorial-solutions/` branch has the completed code for
each step so stuck readers can diff.

**Exit criterion:** Reader has a working translation pipeline where Agent A
receives text, routes to Agent B (translate), and streams the result back.

**Target completion rate:** 60% of quickstart finishers start the tutorial;
40% finish it.

### Stage 3: 2-Hour Deep Dive

**Goal:** Understand the protocol well enough to debug a frame-level issue
and write a custom transport binding.

**Content:** Eight 15-minute modules:

| Module | Topic | Hands-on |
|--------|-------|----------|
| 1 | Layer architecture (RFC 0001) | Draw the stack on paper; label frames |
| 2 | QUIC framing & CBOR wire format (RFC 0002) | `aafp inspect` a captured frame |
| 3 | Identity, ML-DSA-65, AgentId (RFC 0003) | Generate two identities; verify a signature by hand |
| 4 | Discovery: Kademlia DHT (RFC 0004) | Run a 10-node DHT locally; `aafp peers --dht` |
| 5 | Error model (RFC 0005) | Trigger each error code; read the frame |
| 6 | Versioning & compatibility (RFC 0006) | Run a v0 agent against a v1 agent |
| 7 | MCP & A2A bindings (RFC 0007/0008) | Expose an MCP tool over AAFP |
| 8 | NAT traversal in practice | Two agents behind NAT; relay + DCuTR |

**Format:** Each module is a page with a "Try it" section that runs real
commands against a local cluster. A `deep-dive-lab/` Docker Compose file
spins up the required topology.

**Exit criterion:** Reader completes a 10-question self-assessment quiz with
8+ correct answers. The quiz is graded client-side; passing is not gated but
is tracked anonymously.

**Target completion rate:** 20% of tutorial finishers start the deep dive;
10% finish it.

### Stage 4: Certification

**Goal:** Verifiable proof that a developer can build and operate AAFP agents
in production.

**Structure:**

- **AAFP Certified Developer** — a proctored or self-paced exam (90 minutes)
  covering: protocol concepts, SDK usage in one language, CLI operations,
  deployment, debugging. Passing score: 75%. Badge issued via Credly.
- **AAFP Certified Operator** — focused on deployment, NAT traversal, DHT
  health, incident response. For SRE/platform teams running AAFP relays.
- **AAFP Certified Contributor** — for protocol/SDK contributors. Requires one
  merged PR and a short review with a maintainer.

**Why certification?** Enterprise adoption. Platform teams need a
defensible reason to choose AAFP. A certification gives them a checkbox for
internal training budgets. It also creates a pool of recognized contributors
who can answer community questions.

**Exam delivery:** Self-paced exams run in a browser-based sandbox (a
containerized AAFP environment). The sandbox has agents, a relay, and a CLI.
Questions are a mix of multiple-choice and "make this command succeed" tasks
graded by the sandbox itself.

**Cost:** Free for individuals. Organizations pay for proctored exams
($150) to fund the program.

### 3.1 Funnel diagram

```
Landing page visitor
        │
        ▼  (70% start quickstart)
  5-min Quickstart ──────► "I got it working" (85% finish)
        │
        ▼  (60% of finishers start tutorial)
  30-min Tutorial ────────► "I built a pipeline" (40% finish)
        │
        ▼  (20% of finishers start deep dive)
  2-hr Deep Dive ─────────► "I understand the protocol" (10% finish)
        │
        ▼  (5% of finishers certify)
  Certification ──────────► "I'm an AAFP Developer"
```

Each arrow is instrumented (Section 13). The numbers are targets, not
measurements; the survey plan defines how we close the gap.

---

## 4. Interactive Playground

### 4.1 Vision

A web page at `/playground` where a visitor can:

1. Type a message to an AAFP agent and get a response — in the browser, no
   install.
2. Watch the agent graph update as agents discover each other.
3. See the CBOR frames on the wire, decoded, as they happen.
4. Edit the agent's handler code (in a Monaco editor) and redeploy with one
   click.

This is the single highest-leverage DX investment. A visitor who can *talk to
an agent in their browser* within 10 seconds of landing on the site is far
more likely to install locally than one who must read first.

### 4.2 Architecture

```
Browser
  ├── Monaco editor (handler code, Rust subset via WASM)
  ├── Agent graph visualizer (D3 force-directed)
  ├── Frame inspector (hex + decoded CBOR)
  └── Chat panel (user ↔ agent)
        │  WebSocket
        ▼
  Playground Gateway (Rust, axum)
        │  spawns per-session
        ▼
  AAFP Mini-Cluster (WASM + server relay)
        ├── Agent A (user's code, compiled in WASM)
        ├── Agent B (echo, pre-built)
        └── Relay (server-side)
```

**Why not pure client-side WASM?** AAFP's QUIC transport and post-quantum TLS
don't run in a browser (browsers don't allow raw UDP/QUIC). The playground
runs a **server-side mini-cluster** per session. The browser talks to it over
WebSocket. The gateway translates WebSocket ↔ AAFP frames. The user's agent
code is compiled to WASM and runs server-side in a WASI sandbox.

**Session lifecycle:**
- Visitor opens `/playground`. Gateway allocates a session (30-second timeout).
- Gateway starts a relay + two agents in the session's WASM sandbox.
- Visitor edits handler code, clicks "Deploy". Gateway compiles the WASM
  module (cached, ~2s) and hot-swaps the agent's handler.
- Visitor types a message. Gateway forwards it as an AAFP frame to Agent A.
  Response streams back to the chat panel. Frames are mirrored to the
  inspector.
- Session expires after 10 minutes of inactivity. Sandbox is torn down.

**Scaling:** Each session is cheap (a WASM runtime + a relay stub). Target
100 concurrent sessions per gateway pod. Horizontal scale behind a load
balancer. Sessions are stateful but short-lived; no sticky sessions needed if
the gateway holds the session in memory and the LB routes by session ID.

**Security:** User code runs in WASM with no filesystem, no network except
the session's relay. No persistent storage. Code is not saved server-side
unless the user clicks "Share" (generates a short URL with the code encoded
in the fragment, like JSFiddle).

### 4.3 What the playground teaches

The playground is not a toy. It exposes:
- **Capability routing** — the user can address a message to a *capability*
  (`translate`) rather than an agent ID, and watch the DHT resolve it.
- **Streaming** — the chat panel renders streamed tokens as they arrive.
- **Errors** — if the user's handler returns an error, the chat panel shows
  the structured error frame, decoded, with a link to the error's doc page.
- **Identity** — each session's agents have real ML-DSA-65 identities. The
  inspector shows the handshake and signature verification.

### 4.4 Playground → local install

A banner above the playground: "Like this? Run it locally in 5 minutes →"
links to the quickstart. A "Download my agent" button exports the user's
handler code as a complete Rust project (a `cargo new` scaffold with their
handler filled in), zipped. This is the conversion path from playground
visitor to installed developer.

---

## 5. SDK Onboarding by Language

AAFP ships SDKs in Rust, Python, and TypeScript. Each has a different
audience and a different onboarding contract. The 3-line API is the same in
all three; the surrounding experience is idiomatic to each language.

### 5.1 The 3-line API (universal)

Every SDK exposes the same shape:

```rust
// Rust
Agent::serve().capability("greet")
    .handler(|req| async move { Ok(Response::text("hi")) })
    .start().await
```

```python
# Python
Agent.serve().capability("greet")(
    lambda req: Response.text("hi")
).start()
```

```typescript
// TypeScript
Agent.serve().capability("greet")
  .handler(async (req) => Response.text("hi"))
  .start()
```

A developer who learns one SDK recognizes the other two instantly. The
concept page for "Your First Agent" shows all three in tabs.

### 5.2 Rust SDK onboarding

**Audience:** Systems developers, protocol contributors, performance-sensitive
users.

**Install:**
```bash
cargo add aafp-sdk
```

**Onboarding contract:**
- `cargo doc` works out of the box.
- The SDK is a single crate with feature flags (`transport-quic`, `transport-mcp`,
  `python` for PyO3). Default features give a working agent.
- Examples live in `crates/aafp-sdk/examples/` and are runnable with
  `cargo run --example`.
- The `aafp-sdk` prelude (`use aafp_sdk::prelude::*`) brings in `Agent`,
  `Request`, `Response`, `Capability`, `Error`. No need to import 10 types.

**Pitfalls to address in docs:**
- Tokio runtime requirement (`#[tokio::main]`). The first example shows this;
  a troubleshooting page covers "panicked at 'no reactor running'".
- Feature-flag matrix. A table maps use case → features.
- Async handler lifetimes. The closure form is documented with a callout:
  "Why `async move`?" linking to a concept page on handler semantics.

**First-run experience:**
```bash
cargo new my-agent && cd my-agent
cargo add aafp-sdk tokio --features tokio/full
# paste 3-line handler from docs
cargo run
# in another terminal:
aafp call greet "World" --addr quic://127.0.0.1:<port>
```

### 5.3 Python SDK onboarding

**Audience:** AI/ML engineers, data scientists, agent developers coming from
LangChain/LlamaIndex.

**Install:**
```bash
pip install aafp
```

The Python SDK is a PyO3 binding over the Rust core. The wheel is prebuilt for
cp38–cp313 on linux/macOS/windows. No Rust toolchain required to install.

**Onboarding contract:**
- `import aafp` gives you `Agent`, `Request`, `Response`, `Capability`.
- Sync and async handlers both supported. The default is sync (simpler for
  AI/ML users who think linearly). Async is `async def handler(req)`.
- Type hints throughout; `pyright` clean.
- A `aafp.notebook` module for Jupyter: run an agent inside a notebook cell,
  call it from the next cell. This is critical for the AI/ML audience who live
  in notebooks.

**Pitfalls to address in docs:**
- "Why do I need an event loop?" — a concept page for notebook users who have
  never written async Python.
- GIL behavior — handlers release the GIL during network I/O, so concurrent
  requests don't block each other. Documented with a benchmark.
- Installation on Apple Silicon — the wheel is universal2; no Rosetta needed.

**First-run experience:**
```bash
pip install aafp
python -c "from aafp import Agent, Response; Agent.serve().capability('greet')(lambda r: Response.text('hi')).start()"
```

**LangChain migration guide:** A dedicated page "Moving from LangChain to
AAFP" maps LangChain concepts (Chain, Tool, Agent, Memory) to AAFP concepts
(Agent, Capability, Handler, Session). Includes a side-by-side rewrite of a
LangChain ReAct agent as an AAFP agent. This is a conversion funnel — LangChain
users are the largest pool of potential AAFP users.

### 5.4 TypeScript SDK onboarding

**Audience:** Full-stack web developers, Node.js backend teams.

**Install:**
```bash
npm install @aafp/sdk
```

The TypeScript SDK is a native JS implementation (not a WASM binding) for
broad compatibility. It uses the Web Crypto API for ML-DSA-65 (where available)
and falls back to a WASM crypto module where not. QUIC is via the `h3`/`quic`
Node modules on Node 22+; browsers use the WebSocket gateway.

**Onboarding contract:**
- `import { Agent, Response } from "@aafp/sdk"` — ESM-first, CJS compatible.
- Deno and Bun supported (tested in CI).
- Handlers are `async` by default (JS idiom).
- A `@aafp/express` adapter mounts an AAFP agent as an Express middleware for
  teams that want to mix HTTP and AAFP.

**Pitfalls to address in docs:**
- "Why not just HTTP?" — the comparison page (Section 14) is linked from the
  TS quickstart because JS developers ask this first.
- Browser vs Node transport differences — a callout box on the first page.
- Crypto availability — a runtime check with a clear error if ML-DSA-65 is
  unavailable (Section 6).

**First-run experience:**
```bash
npm create @aafp/agent my-agent
cd my-agent
npm run dev
# in another terminal:
npx aafp call greet "World" --addr quic://127.0.0.1:<port>
```

### 5.5 Cross-language consistency

A conformance test suite (Section 9.2) verifies that all three SDKs produce
identical wire behavior. A developer who writes an agent in Rust and calls it
from Python gets the same frames, the same errors, the same streaming
semantics. This is tested in CI on every PR.

---

## 6. Error Message Design

### 6.1 The rule

**Every error tells you what happened, why, and how to fix it.**

No bare error codes. No `Error: ECONNREFUSED`. Every error is a structured
object rendered to a human-readable string with three parts:

1. **What:** A one-line description of the failure.
2. **Why:** The most likely cause, in plain language.
3. **Fix:** A concrete action, with a copy-pasteable command where possible.

### 6.2 Error frame structure (wire)

RFC 0005 defines the error frame. The DX layer adds a `hint` field and a
`doc_url` field to the error payload:

```cbor
{
  "code": "CAPABILITY_NOT_FOUND",
  "message": "No agent with capability 'translate' is currently reachable",
  "hint": "Start an agent with --capability translate, or check discovery with 'aafp peers --capability translate'",
  "doc_url": "https://aafp.dev/docs/errors#capability-not-found",
  "retry_after_ms": null,
  "trace_id": "01HXYZ..."
}
```

The `hint` and `doc_url` are populated by the SDK, not the protocol. The
protocol error code is stable (frozen in RFC 0005); the hint is versioned with
the SDK and can be improved release over release.

### 6.3 Error catalog

Every error code in RFC 0005 has a page in `docs/errors/`. The page contains:

- The error code and one-line summary.
- The full structured frame example.
- Common causes (3–5 bullets).
- How to fix (3–5 bullets, with commands).
- How to prevent (lint rule, config, or test).
- Related errors (cross-links).

Example page for `CAPABILITY_NOT_FOUND`:

> ## CAPABILITY_NOT_FOUND
>
> **No agent with the requested capability is currently reachable.**
>
> ### Frame
> ```json
> { "code": "CAPABILITY_NOT_FOUND", "message": "...", "hint": "..." }
> ```
>
> ### Common causes
> - The agent providing the capability is not running.
> - The agent is running but hasn't published its capability to the DHT yet
>   (takes ~2s after startup).
> - The capability name is misspelled (case-sensitive).
> - The caller and provider are on different DHT partitions.
>
> ### Fix
> ```bash
> # Check who's on the network
> aafp peers --capability translate
>
> # If empty, start an agent with the capability
> aafp serve --capability translate
>
> # If the agent is running but not listed, wait 2s and retry
> ```
>
> ### Prevent
> - Use `aafp health --wait-capability translate` in scripts to block until
>   the capability is available.
> - Pin capability names in a shared constants file.

### 6.4 CLI error rendering

In the CLI, errors render with color:

```
✗ CAPABILITY_NOT_FOUND
  No agent with capability 'translate' is currently reachable.

  Why: The agent may not be running, or may not have published to the DHT yet.

  Fix:
    aafp peers --capability translate    # check who's available
    aafp serve --capability translate    # start the missing agent

  Docs: https://aafp.dev/docs/errors#capability-not-found
  Trace: 01HXYZ...
```

The `--json` flag outputs the raw structured frame for scripting.

### 6.5 SDK error ergonomics

In Rust, errors are `thiserror`-derived enums with a `Display` impl that
includes the hint. In Python, errors are exception classes with a `.hint`
attribute and a `__str__` that includes it. In TypeScript, errors are
`Error` subclasses with a `.hint` property.

All three SDKs expose a `Result<T, AafpError>` (or equivalent) so users can
pattern-match on the error code programmatically.

### 6.6 Error-driven docs

Every error's `doc_url` is a permalink. The docs site generates these pages
from a single `errors.yaml` manifest in the repo. Adding a new error code
requires adding a YAML entry (which CI validates against RFC 0005) and a doc
page. No error ships without a doc page — CI enforces this.

---

## 7. Debugging Tools

Three CLI subcommands form the debugging toolkit. Each has a single job and
composes with the others.

### 7.1 `aafp trace` — distributed tracing

**Purpose:** See every frame on every stream for a given request, across
agents.

**Usage:**
```bash
aafp trace --agent <agent-id> --capability translate
```

**Output:** A waterfall view (in the terminal, via `ratatui`) showing:

```
Trace 01HXYZ  (3 agents, 7 frames, 142ms total)

Agent c31810a6 ──DATA──▶ Agent a1b2c3d4   "translate(hello)"        0ms
Agent a1b2c3d4 ──DATA──▶ Agent b2c3d4e5   "llm_translate(hello)"   12ms
Agent b2c3d4e5 ──DATA──▶ Agent a1b2c3d4   "hola"                   98ms
Agent a1b2c3d4 ──DATA──▶ Agent c31810a6   "hola"                  140ms
Agent a1b2c3d4 ──ERR──▶  Agent c31810a6   TIMEOUT                  142ms
```

**How it works:** AAFP agents emit OpenTelemetry spans for every frame. The
`aafp trace` command queries the configured OTel collector (or a built-in
in-memory collector for local dev) and renders the trace. For local
development without an OTel backend, agents can be started with
`--trace-to-stdout` and `aafp trace` reads from a shared log file.

**Export:** `aafp trace --export trace.json` exports the full trace as JSON
for sharing in bug reports. `--export trace.chromium.json` exports in
Chromium trace format, openable in `chrome://tracing`.

### 7.2 `aafp replay` — deterministic replay

**Purpose:** Reproduce a production issue locally by replaying a recorded
sequence of frames.

**Usage:**
```bash
aafp replay --recording issue-42.aafp-trace --against ./my-agent
```

**How it works:** `aafp trace --record` saves a trace as an `.aafp-trace`
file (CBOR-encoded list of frames with timestamps). `aafp replay` starts the
user's agent (from a binary or a `cargo run` command) and feeds it the
recorded frames in order, with the original timing. The agent's responses are
compared to the recorded responses; mismatches are highlighted.

**Use cases:**
- "A user reported a timeout in production. I have the trace ID. I replay it
  locally against my agent and see the same timeout. I add a print, replay
  again, find the bug."
- Regression testing: a `.aafp-trace` file is checked into the repo and
  replayed in CI to verify the agent still handles it correctly.

**Determinism:** Replay is deterministic if the agent's handler is
deterministic. For non-deterministic agents (e.g., calling an LLM), replay
can stub external calls via a `--stub` flag that returns canned responses for
given capability calls.

### 7.3 `aafp inspect` — frame-level inspection

**Purpose:** Decode a single CBOR frame to human-readable form.

**Usage:**
```bash
aafp inspect --frame frame.cbor
# or from a trace:
aafp trace --export-frames | aafp inspect
# or from a live capture:
aafp inspect --capture quic://127.0.0.1:52069
```

**Output:**
```
Frame #3  (stream 0, 142 bytes)

  Type:     DATA (0x03)
  Flags:    END_STREAM | COMPRESSED
  Length:   134

  Payload (CBOR):
    {
      "method": "translate",
      "params": { "text": "hello", "source": "en", "target": "es" },
      "id": 42
    }

  Hex (first 32 bytes):
    03 83 a6 6d 65 74 68 6f  64 69 74 72 61 6e 73 6c
    61 74 65 a6 74 65 78 74  65 68 65 6c 6c 6f 66 73

  Signature: ML-DSA-65, verified ✓ (AgentId a1b2c3d4)
```

**Integration with playground:** The playground's frame inspector (Section
4.2) is the web version of `aafp inspect`. They share the CBOR decoder.

### 7.4 Composition

The three tools compose:

```bash
# Capture a trace, replay it against a fixed agent, inspect the failing frame
aafp trace --record --output bug.aafp-trace
aafp replay --recording bug.aafp-trace --against ./target/release/my-agent
aafp inspect --frame <(aafp trace --export-frames bug.aafp-trace --frame 5)
```

### 7.5 `aafp doctor` — environment diagnostics

A bonus tool: `aafp doctor` checks the local environment and reports issues:

```
AAFP Doctor
  ✓ Rust toolchain: 1.79.0
  ✓ aafp CLI: v1.2.0
  ✗ QUIC UDP port 443 not available (relay will use 52069)
    Fix: sudo setcap 'cap_net_bind_service=+ep' ./aafp
  ✓ Identity file: aafp-identity.bin (ML-DSA-65)
  ⚠ No bootstrap peers configured
    Fix: aafp config set bootstrap /dnsaddr/bootstrap.aafp.dev
  ✓ DNS: resolves aafp.dev in 12ms
```

`aafp doctor` runs on first run after install and on demand. It's the
fastest path from "something is weird" to "here's what's weird."

---

## 8. IDE Support

### 8.1 VS Code extension: `aafp-vscode`

A single VS Code extension provides:

1. **Syntax highlighting** for `.aafp` config files (TOML-based agent configs).
2. **Language server** for Rust, Python, and TypeScript AAFP code.
3. **Agent Explorer** sidebar.
4. **Frame inspector** inline on `.aafp-trace` files.
5. **Snippets** for common agent patterns.
6. **Error squiggles** with inline hints (the same hints as CLI errors).

### 8.2 `.aafp` config files

Agent configs are TOML files with a schema:

```toml
# my-agent.aafp
[agent]
name = "translator"
identity = "aafp-identity.bin"

[capabilities]
translate = { handler = "translate_handler", streaming = true }

[discovery]
bootstrap = ["/dnsaddr/bootstrap.aafp.dev"]
advertise = true

[transport]
listen = "quic://0.0.0.0:52069"
```

The extension provides:
- Syntax highlighting for keys, values, and sections.
- Autocomplete for known keys (from a JSON schema).
- Hover docs for each key.
- Validation: missing required keys, invalid values, unknown capabilities.
- A "Run" code lens above `[agent]` that starts the agent with `aafp serve
  --config <file>`.

### 8.3 Language server

The LSP provides:

- **Diagnostics:** Unknown capability, handler signature mismatch, missing
  identity file, unreachable bootstrap peer.
- **Hover:** Type signatures for `Agent`, `Request`, `Response`, `Capability`.
  Error code descriptions when hovering over an error variant.
- **Go-to-definition:** From a capability name in a config to the handler
  function in code. From an `Agent::serve()` call to the SDK source.
- **Completion:** Capability names (from the workspace's agents), handler
  skeletons, error codes.
- **Code actions:** "Wrap handler in error handling", "Add streaming support",
  "Generate conformance test for this capability".

The LSP is written in Rust (using `tower-lsp`) and ships in the extension as a
binary. It talks to the workspace's SDK via the language's native tooling
(`rust-analyzer` for Rust, `pyright` for Python, `tsserver` for TS) and adds
AAFP-specific checks on top.

### 8.4 Agent Explorer

A sidebar panel in VS Code showing the live agent graph:

```
AAFP Agent Explorer
  ──────────────────
  Local Agents
    ▸ translator (a1b2c3d4)  ● healthy
        Capabilities: translate, detect-language
        Streams: 3 active
    ▸ echo (c31810a6)        ● healthy
  Network
    ▸ relay-1 (b2c3d4e5)     ● healthy
    ▸ llm-provider (e5f6a7b8) ⚠ degraded (200ms p99)
  ──────────────────
  [Start Agent]  [Call Agent]
```

Clicking an agent shows its capabilities, active streams, and recent frames.
Clicking a stream opens the frame inspector. The "Call Agent" button opens an
input box for a capability and message, and shows the response in an output
channel.

The Explorer connects to the local AAFP network via the same discovery
mechanism as the CLI. No extra config needed — if `aafp peers` works, the
Explorer works.

### 8.5 JetBrains plugin (Phase 3)

A JetBrains plugin (IntelliJ, PyCharm, WebStorm) is Phase 3 work. It reuses
the LSP via the LSP4IJ plugin. The Agent Explorer is a JetBrains Tool Window.
Lower priority than VS Code because the initial audience (Rust + AI/ML) skews
VS Code.

---

## 9. CLI Improvements

The existing CLI (`aafp serve`, `aafp call`, `aafp peers`, `aafp metrics`,
`aafp health`, `aafp init`, `aafp quickstart`) is the v1 baseline. Phase 2
adds three developer-facing subcommands and polishes the existing ones.

### 9.1 `aafp dev` — hot-reload development server

**Purpose:** Start an agent and reload it when code changes.

**Usage:**
```bash
aafp dev --handler ./src/main.rs
# or for a full project:
aafp dev --project ./my-agent
```

**Behavior:**
- Watches the source directory for changes.
- On change, recompiles (incremental, ~1s for small changes) and hot-swaps
  the agent's handler without dropping active streams.
- Streams a unified log to the terminal: compile errors, agent logs, and
  incoming requests, color-coded.
- On compile error, shows the error inline (using the Section 6 format) and
  keeps the previous handler running so the agent doesn't go down during
  development.

**For Python:** `aafp dev --handler agent.py` watches the file and re-imports
the module on change. No compilation step.

**For TypeScript:** `aafp dev --handler agent.ts` uses `tsx watch` under the
hood.

**Why this matters:** The current loop is "edit, Ctrl+C, cargo run, wait,
call." `aafp dev` collapses this to "edit, see it live." This is the single
biggest day-to-day DX win for agent developers.

### 9.2 `aafp test` — conformance testing

**Purpose:** Verify an agent conforms to the AAFP protocol and to its
declared capabilities.

**Usage:**
```bash
aafp test --agent ./my-agent
```

**Behavior:** Runs a suite of conformance tests against the agent:

1. **Handshake tests:** v1 handshake succeeds; rejects invalid signatures;
   rejects expired UCANs.
2. **Frame tests:** accepts valid DATA frames; rejects malformed frames with
   the correct error code; handles END_STREAM correctly.
3. **Capability tests:** responds to declared capabilities; returns
   CAPABILITY_NOT_FOUND for undeclared ones; handles concurrent requests.
4. **Error tests:** returns structured error frames for each error scenario;
   error codes match RFC 0005.
5. **Streaming tests:** streams chunks in order; respects cancellation.
6. **Discovery tests:** publishes capabilities to DHT; responds to
   capability queries.

**Output:**
```
AAFP Conformance Tests  (v1.2.0)

  Handshake ............ 8/8  ✓
  Framing .............. 12/12 ✓
  Capabilities ......... 6/6  ✓
  Errors ............... 9/9  ✓
  Streaming ............ 4/4  ✓
  Discovery ............ 3/3  ✓

  42/42 passed in 1.3s

  Conformance: AAFP v1 ✓
```

**CI integration:** `aafp test --junit results.xml` emits JUnit XML for CI.
`--ci` flag exits non-zero on any failure.

**Custom tests:** Users can add project-specific tests in an
`aafp-tests/` directory; `aafp test` runs them alongside the conformance
suite.

### 9.3 `aafp bench` — performance benchmarking

**Purpose:** Measure an agent's throughput, latency, and resource use.

**Usage:**
```bash
aafp bench --agent ./my-agent --duration 30s --concurrency 100
```

**Output:**
```
AAFP Benchmark  (30s, 100 concurrent)

  Throughput:    12,847 req/s
  Latency:       p50=3.1ms  p95=8.2ms  p99=14.7ms
  Errors:        0 (0.00%)
  CPU:           340% (3.4 cores)
  Memory:        142 MB peak
  Streams:       100 peak, 0 resets

  Comparison:
    v1.2.0: 12,847 req/s  (baseline)
    v1.1.0:  9,200 req/s  (+39.6%)
```

**Features:**
- `--compare <previous-bench.json>` compares to a prior run and highlights
  regressions.
- `--load-profile <profile.yaml>` runs a mixed workload (e.g., 70% translate,
  20% detect-language, 10% summarize) to simulate real traffic.
- `--flame` generates a flamegraph (via `pprof-rs`) for CPU profiling.
- Results are storable as JSON for trend tracking.

### 9.4 Existing command polish

| Command | Improvement |
|---------|-------------|
| `aafp init` | Becomes `aafp init --template <name>` pulling from the template repo (Section 10). Interactive if no template given. |
| `aafp serve` | Adds `--config <file>` to load from `.aafp` config. `--watch` flag for hot reload (alias for `aafp dev`). |
| `aafp call` | Adds `--stream` to render streamed responses token-by-token. `--timeout` with a clear error on expiry. |
| `aafp peers` | Adds `--capability <name>` filter. `--json` for scripting. `--watch` for live updates. |
| `aafp health` | Adds `--wait-capability <name>` that blocks until the capability is available (for scripts). |
| `aafp metrics` | Adds `--prometheus` to export in Prometheus format. |

### 9.5 CLI ergonomics principles

- **Every command has `--help` with examples.** Not just flags — real
  examples at the bottom of the help text.
- **Every command has `--json`.** For scripting and for piping to `jq`.
- **Exit codes are meaningful.** 0 = success, 1 = app error, 2 = usage error,
  3 = network error, 4 = conformance failure. Documented in `aafp help
  exit-codes`.
- **Color is on by default, off with `--no-color` or `NO_COLOR=1`.** Respects
  the `NO_COLOR` env var convention.
- **Progress is shown for long operations.** `aafp bench` shows a progress bar;
  `aafp test` shows a spinner per suite.

---

## 10. Template Repository

### 10.1 `aafp init`

```bash
aafp init my-agent
```

Creates a working agent in 30 seconds. The user picks a template (or accepts
the default) and gets a project that compiles, runs, and passes `aafp test`.

**Interactive flow:**
```
$ aafp init my-agent
? Language: (Rust/Python/TypeScript) › Rust
? Template: (Basic agent/Streaming/MCP server/Multi-agent) › Basic agent
? Capability name: › greet
✓ Created my-agent/
✓ Cargo.toml, src/main.rs, aafp.toml, tests/conformance.aafp-test
✓ Running aafp test... 6/6 passed
✓ Done. Next: cd my-agent && aafp dev
```

### 10.2 Template catalog

Templates live in a `aafp-templates` repo and are fetched by URL:

| Template | Description | Languages |
|----------|-------------|-----------|
| `basic` | Single agent, one capability, sync handler | Rust, Python, TS |
| `streaming` | Agent that streams a response token-by-token | Rust, Python, TS |
| `mcp-server` | Exposes MCP tools over AAFP | Rust, Python, TS |
| `multi-agent` | Two agents + relay, docker-compose | Rust, Python |
| `relay` | A relay node for NAT traversal | Rust |
| `gateway` | HTTP ↔ AAFP gateway (for web frontends) | TS |
| `pipeline` | Multi-step agent pipeline (translate → summarize → store) | Rust, Python |
| `scheduled` | Agent that runs on a schedule (cron-like) | Rust, Python |
| `notebook` | Jupyter notebook with an inline AAFP agent | Python |
| `express` | Express app with an AAFP agent mounted | TS |

Each template includes:
- Working code that compiles/runs.
- `aafp.toml` config.
- `tests/conformance.aafp-test` — passes `aafp test`.
- `README.md` with run instructions.
- `.github/workflows/ci.yml` — runs `aafp test` on push.

### 10.3 Template versioning

Templates are tagged with the AAFP version they target. `aafp init` fetches
the template matching the installed CLI version. `aafp init --template
basic@v1.2.0` pins a specific version. This prevents template/SDK skew.

### 10.4 Custom templates

`aafp init --template ./my-template` uses a local directory as a template.
This lets organizations create internal templates (e.g., "company-standard
agent with auth middleware") and bootstrap teams consistently.

---

## 11. Example Gallery

### 11.1 Goal

20+ runnable examples, categorized by use case, each with a one-paragraph
description, a run command, and a link to the source. The gallery is a page
on the docs site and a directory in the repo.

### 11.2 Categories and examples

| Category | Example | What it shows |
|----------|---------|---------------|
| **Getting Started** | `echo-agent` | Minimal agent, one capability |
| | `greet-agent` | Agent with a parameterized handler |
| | `docker-compose` | 3-agent setup with relay |
| **Streaming** | `streaming-echo` | Streams response in chunks |
| | `token-stream` | Simulates LLM token streaming |
| | `progress-reporter` | Streams progress updates for a long task |
| **Discovery & Routing** | `capability-routing` | Call by capability, not address |
| | `dht-lookup` | Manual DHT query and inspection |
| | `multi-relay` | Two relays, agents behind each |
| **MCP Integration** | `mcp-over-aafp` | Expose MCP tools over AAFP |
| | `mcp-weather` | Weather tool via MCP over AAFP |
| | `mcp-filesystem` | Filesystem tool via MCP over AAFP |
| **A2A Integration** | `a2a-interop` | AAFP agent talking to an A2A agent |
| **Pipelines** | `translation-pipeline` | Translate → detect → summarize |
| | `research-pipeline` | Search → extract → summarize → store |
| | `review-pipeline` | Code review agent with multiple checks |
| **Security** | `ucan-delegation` | Delegate a capability to another agent |
| | `trusted-peers` | Pin a set of trusted agent IDs |
| | `identity-rotation` | Rotate an agent's identity |
| **NAT Traversal** | `behind-nat` | Agent behind NAT via relay |
| | `dcutr-hole-punch` | Direct connection after hole punching |
| **Deployment** | `k8s-deployment` | Agents on Kubernetes with autoscaling |
| | `systemd-service` | Agent as a systemd service |

### 11.3 Example format

Each example is a directory:

```
examples/translation-pipeline/
├── README.md          # What it does, how to run, what to look for
├── aafp.toml          # Config for the agents
├── docker-compose.yml # One-command run
├── src/
│   ├── translator.rs
│   ├── detector.rs
│   └── summarizer.rs
└── tests/
    └── conformance.aafp-test
```

The `README.md` follows a template:

```markdown
# Translation Pipeline

Three agents form a pipeline: translate → detect-language → summarize.
Demonstrates capability routing, streaming, and multi-agent composition.

## Run

\`\`\`bash
docker compose up
# in another terminal:
aafp call summarize "Hello world, this is a test" --addr quic://127.0.0.1:52069
\`\`\`

## What to look for

- The `summarize` capability routes to the summarizer agent, which calls
  `translate` and `detect-language` on the input.
- The response streams in as each step completes.
- `aafp peers` shows all three agents and their capabilities.

## Architecture

[diagram]
```

### 11.4 Gallery page

The docs site gallery page (`/examples`) is a filterable grid:

- Filter by category, language, difficulty.
- Each card shows the title, one-line description, language badge, and a
  "Run" button that copies the `docker compose up` (or equivalent) command.
- A "Source" link goes to the example's directory in the repo.

### 11.5 CI

Every example is built and tested in CI. `aafp test` runs against each. A
broken example fails the build. This is the same principle as doc-tests
(Section 2.4): examples are runnable, not illustrative.

---

## 12. Community Documentation

### 12.1 Contributing guide

`CONTRIBUTING.md` at the repo root covers:

1. **Ways to contribute:** Code, docs, examples, bug reports, feature
   requests, community support.
2. **Development setup:** Clone, build, test — the 5-minute version.
3. **Code style:** `cargo fmt`, `cargo clippy -D warnings`, the workspace's
   lint rules. Python: `ruff` + `mypy`. TS: `eslint` + `prettier`.
4. **PR process:** Fork → branch → PR → CI → review → merge. Small PRs
   preferred. Link the issue. Include tests.
5. **Commit messages:** Conventional Commits (`feat:`, `fix:`, `docs:`).
   `cargo-release` generates changelogs from them.
6. **Code of Conduct:** Contributor Covenant 2.1. Enforced by maintainers.
7. **Recognition:** All contributors added to `AUTHORS.md`. Significant
   contributors invited to the maintainers team (Section 12.3).

### 12.2 RFC process

The protocol is frozen at Rev 6, but the RFC process continues for
extensions (RFCs 0009+). The process is documented in `RFCs/PROCESS.md`:

1. **Pre-RFC:** A discussion post in GitHub Discussions. Gauge interest.
2. **Draft:** Author writes `RFCs/00XX-title.md` with the template. PR to the
   repo. Label `rfc-draft`.
3. **Review:** Maintainers and community review. 2-week minimum. Iteration.
4. **Last Call:** Label `rfc-last-call`. 1-week final comment period.
5. **Accepted/Rejected:** Maintainers decide. Accepted RFCs are merged and
   labeled `rfc-accepted`. Implementation can begin.
6. **Implemented:** Once a reference implementation exists and passes
   conformance, the RFC is labeled `rfc-implemented` and the spec is frozen
   for that RFC number.
7. **Amendments:** Changes to frozen RFCs require a new amendment file
   (`AMENDMENTS-00XX.md`) and maintainer approval. The bar is high: breaking
   changes require a new RFC number, not an amendment.

**RFC template:**
```markdown
# RFC NNNN: Title
- Status: draft
- Author: name
- Created: YYYY-MM-DD

## Summary
One paragraph.

## Motivation
Why this change?

## Design
Detailed design.

## Alternatives
What else was considered?

## Risks
What could go wrong?

## Compatibility
Does this break existing agents?
```

### 12.3 Governance

`GOVERNANCE.md` documents:

- **Roles:** Contributor, Maintainer, Lead Maintainer. Each role's
  responsibilities and privileges.
- **Decision making:** Consensus among maintainers. Lead Maintainer breaks
  ties. Protocol changes require an RFC; implementation changes require a PR
  with maintainer approval.
- **Teams:** Protocol team, Rust impl team, Go impl team, Python SDK team,
  TS SDK team, Docs team, DevRel team. Each team has a lead and a charter.
- **Elections:** Maintainer team self-selects by nomination + consensus.
  Lead Maintainer elected annually by maintainers.
- **Transparency:** All decisions in GitHub Discussions or RFC PRs. No
  private decision channels for protocol matters. Private channels only for
  security (coordinated disclosure).

### 12.4 Security policy

`SECURITY.md`:
- Report vulnerabilities via GitHub Security Advisories (private).
- 90-day disclosure deadline, extendable by mutual agreement.
- Security releases get a CVE and a coordinated advisory.
- The threat model is in `docs/THREAT_MODEL.md` (already exists).

### 12.5 Community channels

- **GitHub Discussions:** Q&A, ideas, pre-RFCs.
- **Discord:** Real-time chat. Channels: `#help`, `#rust`, `#python`,
  `#typescript`, `#protocol`, `#random`. Moderated by maintainers.
- **Office hours:** Biweekly 1-hour video call. Maintainers answer questions.
  Recorded and posted.
- **Blog:** `aafp.dev/blog`. Release notes, deep dives, case studies.

---

## 13. Developer Survey Design

### 13.1 What to measure

The survey instruments the funnel (Section 3.1) and the DX principles
(Section 1). Five metrics, each with a target:

| Metric | Definition | Target | Instrument |
|--------|------------|--------|------------|
| **Time-to-first-message (TTFM)** | Minutes from first page view to first successful `aafp call` | < 5 min | Playground + quickstart widget |
| **Quickstart completion rate** | % of quickstart starters who report success | 85% | Thumbs-up widget |
| **Tutorial completion rate** | % of tutorial starters who finish | 40% | Page-flow analytics + end-of-tutorial survey |
| **Net Promoter Score (NPS)** | "How likely to recommend AAFP?" (0–10) | > 40 | Quarterly email survey |
| **Error recovery rate** | % of users who hit an error and recover without filing an issue | 80% | Error-page "Did this help?" widget |

### 13.2 How to measure

**Passive (always-on):**
- **Playout analytics:** Page views, time on page, scroll depth, click
  tracking on copy buttons and "Run" buttons. Privacy-respecting
  (Plausible, not Google Analytics). No cookies, no PII.
- **Quickstart widget:** At the bottom of the quickstart, a two-button
  widget: "It worked!" / "I'm stuck." Clicking "I'm stuck" opens a
  short form: "Where did you get stuck?" (select step) + optional comment.
- **Error-page widget:** On every `docs/errors/*` page, "Did this fix your
  problem?" Yes/No. No → "What went wrong?" textarea.
- **CLI telemetry (opt-in):** `aafp` asks on first run whether to send
  anonymous usage stats. If yes, sends: command name, success/failure, error
  code, duration. No arguments, no payloads, no identity. Opt-out anytime
  with `aafp config set telemetry off`.

**Active (periodic):**
- **Quarterly developer survey:** Emailed to everyone who has starred the
  repo, joined Discord, or opted into the newsletter. 10 questions:
  1. How did you first hear about AAFP?
  2. What were you trying to do when you tried AAFP?
  3. Did you get it working? (Yes / Partially / No)
  4. If no/partially, where did you get stuck?
  5. How long did it take to get your first agent working?
  6. What's the best thing about AAFP so far?
  7. What's the most frustrating thing?
  8. What other frameworks/tools do you use for agent development?
  9. How likely are you to recommend AAFP to a colleague? (0–10)
  10. Can we follow up with you? (email, optional)
- **Post-tutorial survey:** Shown at the end of the tutorial. 3 questions:
  1. Did you finish the tutorial? (Yes / No, stopped at step ___)
  2. What was confusing?
  3. What would you build with AAFP?

### 13.3 How to iterate

**Cadence:**
- **Weekly:** Review passive metrics (playground, quickstart, error pages).
  If TTFM spikes or a quickstart step's "stuck" rate jumps, investigate.
- **Monthly:** Review CLI telemetry aggregate. If a command has a high
  failure rate, improve its error message or docs.
- **Quarterly:** Send the developer survey. Publish results in a blog post.
  Set DX goals for the next quarter based on results.

**Closing the loop:**
- Every survey response is read by a maintainer within 1 week.
- "Stuck" reports on the quickstart are triaged like bug reports: if 5 people
  get stuck at the same step in a week, it's a P2 docs issue.
- Error-page "No" responses are correlated with the error code. If an error
  page has a > 30% "No" rate, the hint is rewritten and the page is updated.

**Privacy and ethics:**
- All data is aggregate and anonymous except where the user explicitly
  provides an email for follow-up.
- Telemetry is opt-in, granular, and documented at
  `docs/privacy/telemetry.md`.
- Survey results are published openly; raw data is not shared.

### 13.4 Instrumentation implementation

- **Plausible** for site analytics (self-hosted, GDPR-friendly).
- **Custom widget** for quickstart/error feedback (a 50-line React component
  posting to a Cloudflare Worker that writes to a SQLite DB).
- **CLI telemetry** via a `telemetry` crate that batches and sends to the
  same Worker. Respects `DO_NOT_TRACK` and `NO_COLOR`-style env vars.

---

## 14. Competitive Comparison

How does AAFP's developer experience compare to the tools a developer might
reach for instead? This comparison is honest about gaps and is published on
the docs site (`/comparison`) — not as marketing, but as a decision tool.

### 14.1 The competitors

| Tool | What it is | Why someone would choose it |
|------|-----------|-----------------------------|
| **gRPC** | RPC framework over HTTP/2 | Industry standard, strong typing, polyglot |
| **tRPC** | End-to-end typesafe RPC for TS | Zero boilerplate in TS monorepos |
| **LangChain** | Agent framework (orchestration, tools, memory) | Rich ecosystem, LLM integrations, fast prototyping |

### 14.2 Comparison matrix

| Dimension | AAFP | gRPC | tRPC | LangChain |
|-----------|------|------|------|-----------|
| **Time to first call** | ~5 min (target) | ~15 min (proto + gen + impl) | ~2 min (TS only) | ~10 min (install + LLM key) |
| **Transport** | QUIC + post-quantum TLS | HTTP/2 + TLS | HTTP | HTTP (to LLM APIs) |
| **Identity** | ML-DSA-65, AgentId = hash(pubkey) | mTLS or tokens | None (app-level) | API keys |
| **Discovery** | Kademlia DHT, capability routing | DNS / service mesh | None (hardcoded URLs) | None (hardcoded) |
| **NAT traversal** | Built-in (relay, DCuTR) | No (needs LB/mesh) | No | No |
| **Streaming** | Native (QUIC streams) | Native (HTTP/2 streams) | Via subscriptions | Via callbacks |
| **Polyglot** | Rust, Python, TS SDKs | 11+ languages | TS only | Python, JS |
| **Type safety** | Runtime (CBOR schema) + SDK types | Compile-time (proto) | Compile-time (TS) | None |
| **Error messages** | Structured + hint + doc URL | Status codes + details | TS errors | Python tracebacks |
| **Debugging** | trace, replay, inspect | grpcurl, postman | Browser devtools | Print + LangSmith |
| **Hot reload** | `aafp dev` (target) | Manual | `tsc --watch` | Manual |
| **Testing** | `aafp test` (conformance) | grpcurl, postman | Vitest | Manual / evals |
| **Benchmarking** | `aafp bench` (target) | ghz | Manual | Manual |
| **IDE support** | VS Code ext (target) | Protobuf plugins | TS LSP | Minimal |
| **Docs** | Docusaurus site (target) | protobuf.dev | trpc.io | python.langchain.com |
| **Community** | Discord, RFCs (target) | CNCF, mature | Discord, active | Discord, huge |
| **Maturity** | v1, new | Production, years | Production | Production, chaotic |

### 14.3 Where AAFP wins

1. **Agent-native.** gRPC/tRPC are RPC frameworks; you build the agent
   patterns on top. AAFP has discovery, capability routing, identity, and
   trust built in. For agent-to-agent communication, AAFP is less code.
2. **Decentralized by default.** No central broker, no service mesh, no API
   gateway. Agents find each other. This is unique — none of the competitors
   do P2P discovery.
3. **Post-quantum security.** No competitor ships PQ TLS by default. For
   security-conscious deployments (finance, healthcare, government), this is
   a differentiator.
4. **NAT traversal built-in.** gRPC and tRPC require infrastructure (LBs,
   meshes, tunnels) to cross NAT. AAFP does it in the protocol. For
   edge/IoT/distributed agents, this is significant.
5. **Structured errors with fixes.** gRPC gives you status codes. AAFP gives
   you a hint and a doc URL. This closes the loop between error and fix.

### 14.4 Where AAFP must catch up

1. **Ecosystem size.** LangChain has hundreds of integrations; gRPC has a
   decade of tooling. AAFP has 20 examples. The example gallery (Section 11)
   and template repo (Section 10) are the response, but this is a multi-year
   gap.
2. **Language coverage.** gRPC supports 11+ languages. AAFP has 3. Go is in
   progress (wire-format only). Java, C#, C++ are not started. For
   enterprises with polyglot estates, this is a blocker.
3. **Maturity of docs.** gRPC and LangChain have extensive, battle-tested
   docs. AAFP's docs are being built (this plan). The gap closes with
   execution, not strategy.
4. **Community size.** LangChain's Discord has 25K+ members. AAFP's is
   being launched. Community is a function of adoption, which is a function
   of DX — which is what this plan addresses.
5. **Observability.** gRPC has Zipkin/Jaeger integration baked in via
   OpenTelemetry. AAFP has OTel spans (for `aafp trace`) but no pre-built
   Grafana dashboards or Datadog integration. Phase 3 work.

### 14.5 Positioning statement

> For developers building **systems of autonomous agents** that need to
> discover, trust, and coordinate with each other **without a central
> broker**, AAFP is the protocol that provides **decentralized identity,
> capability routing, and post-quantum security** out of the box — unlike
> gRPC (which is transport-only), tRPC (which is TS-only), or LangChain
> (which orchestrates but doesn't provide a transport or trust layer).

This is not "AAFP is better than everything." It's "AAFP is for a job the
others don't do." The comparison page says this plainly. Developers who need
RPC between microservices should use gRPC. Developers building a TS monorepo
should use tRPC. Developers orchestrating a single LLM should use LangChain.
Developers building **networks of agents that find and trust each other**
should use AAFP.

---

## 15. Implementation Roadmap

Phase 2 is scoped at 1–2 weeks per the README. This plan is larger than 2
weeks of work; it's phased into must-have (Phase 2), should-have (Phase 2.5),
and nice-to-have (Phase 3).

### Phase 2: Core DX (Weeks 1–2)

| Item | Effort | Owner |
|------|--------|-------|
| Docusaurus site scaffold + content migration | 2 days | Docs |
| 5-min quickstart (web version) | 1 day | Docs |
| 30-min tutorial | 2 days | Docs |
| `aafp dev` (hot reload) | 2 days | CLI |
| `aafp test` (conformance) | 2 days | CLI |
| Error hints + doc URLs in SDK | 1 day | SDK |
| `aafp init` with templates | 1 day | CLI |
| 5 templates (basic, streaming, mcp-server, multi-agent, relay) | 2 days | SDK |
| 10 examples (from existing examples/ + new) | 2 days | Examples |
| CONTRIBUTING.md + GOVERNANCE.md + SECURITY.md | 1 day | Maintainers |
| Plausible analytics + quickstart widget | 1 day | DevRel |

### Phase 2.5: Polish (Weeks 3–4)

| Item | Effort | Owner |
|------|--------|-------|
| Interactive playground (MVP) | 4 days | DevRel + CLI |
| `aafp bench` | 2 days | CLI |
| `aafp trace` | 3 days | CLI |
| `aafp replay` | 2 days | CLI |
| `aafp inspect` | 1 day | CLI |
| `aafp doctor` | 1 day | CLI |
| VS Code extension (syntax + LSP basics) | 4 days | Tooling |
| Agent Explorer in VS Code | 2 days | Tooling |
| 2-hr deep dive (8 modules) | 4 days | Docs |
| Error catalog (all RFC 0005 codes) | 2 days | Docs |
| Example gallery page | 1 day | Docs |
| Quarterly survey #1 | 1 day | DevRel |

### Phase 3: Ecosystem (Weeks 5+)

| Item | Effort | Owner |
|------|--------|-------|
| Playground frame inspector + graph visualizer | 3 days | DevRel |
| Certification exam + sandbox | 5 days | DevRel |
| JetBrains plugin (via LSP) | 3 days | Tooling |
| 10 more examples (to 20+) | 4 days | Examples |
| 5 more templates | 2 days | SDK |
| Grafana dashboard pack | 2 days | Ops |
| Datadog integration | 2 days | Ops |
| i18n (docs in 2 more languages) | 5 days | Community |
| Python notebook SDK polish | 3 days | Python SDK |
| TypeScript Express adapter | 2 days | TS SDK |

---

## 16. Success Metrics

### 16.1 Phase 2 exit criteria

- [ ] TTFM < 5 minutes for 85% of quickstart starters.
- [ ] `aafp dev`, `aafp test`, `aafp init` shipped and documented.
- [ ] Docusaurus site live at aafp.dev (or GitHub Pages) with quickstart,
      tutorial, and API reference for Rust.
- [ ] 5 templates, 10 examples, all runnable in CI.
- [ ] Every RFC 0005 error code has a doc page with a hint.
- [ ] CONTRIBUTING, GOVERNANCE, SECURITY published.
- [ ] Plausible analytics + quickstart feedback widget live.
- [ ] First quarterly developer survey sent.

### 16.2 6-month targets

- 1,000 GitHub stars (from ~current baseline).
- 500 Discord members.
- 50 community-contributed examples/PRs.
- NPS > 40.
- 10 certified developers.
- 3 case studies (companies or projects using AAFP in production).

### 16.3 12-month targets

- 5,000 GitHub stars.
- 2,000 Discord members.
- 100 community-contributed examples/PRs.
- NPS > 50.
- 50 certified developers.
- SDK in 5 languages (add Go, Java).
- 1 conference talk (RustConf, KubeCon, or AI engineer summit).

### 16.4 The one metric that matters

If we can only measure one thing, it's **TTFM**. If a developer can go from
zero to a working agent in under 5 minutes, everything else — adoption,
community, contributions — follows. If they can't, nothing else matters. Every
DX decision is evaluated against: *Does this lower TTFM?* If not, it's Phase 3.

---

## Appendix A: Existing Assets

This plan builds on existing work in the repo:

| Asset | Location | Role in DX plan |
|-------|----------|-----------------|
| Quickstart | `docs/QUICKSTART.md` | Migrated to Docusaurus `01-quickstart/` |
| Deployment guide | `docs/DEPLOYMENT.md` | Migrated to `07-deployment/` |
| Operations runbook | `docs/OPERATIONS.md` | Migrated to `08-operations/` |
| Troubleshooting | `docs/TROUBLESHOOTING.md` | Migrated + linked from error pages |
| Threat model | `docs/THREAT_MODEL.md` | Migrated to `04-deep-dive/security/` |
| RFCs 0001–0011 | `RFCs/` | Rendered in `09-rfcs/` (frozen) |
| Examples | `examples/` | Expanded to 20+ (Section 11) |
| Docker Compose | `docker-compose.yml` | Used in quickstart + tutorial |
| K8s manifests | `deploy/` | Used in deployment example |
| Rust SDK | `implementations/rust/crates/aafp-sdk` | API reference + onboarding (Section 5.2) |
| CLI | `implementations/rust/crates/aafp-cli` | Improved (Section 9) |

## Appendix B: Tooling Dependencies

| Tool | Purpose | Cost |
|------|---------|------|
| Docusaurus | Docs site | Free (OSS) |
| Plausible | Analytics | $9/mo (self-hosted) or cloud |
| Algolia DocSearch | API search | Free for OSS |
| Cloudflare Workers | Feedback widget + telemetry | Free tier |
| Credly | Certification badges | Free for issuers |
| Discord | Community | Free (Nitro optional) |
| GitHub Actions | CI for docs, examples, tests | Free for OSS |
| `cargo doc`, `pdoc`, `TypeDoc` | API reference | Free |

## Appendix C: Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Playground is too expensive to host | Medium | High | Start with 20 concurrent sessions; scale on demand; cap session length |
| Docs drift from code | High | Medium | Doc-extraction CI gate (Section 2.4) |
| Error hints become stale | Medium | Medium | Error catalog generated from `errors.yaml`; CI validates against RFC 0005 |
| SDKs diverge in behavior | Medium | High | Conformance test suite runs against all three SDKs in CI |
| Community doesn't materialize | Medium | High | DX investment (this plan) is the primary driver; office hours + Discord engagement |
| Certification has low uptake | High | Low | Free for individuals; only invest in proctored exams if demand exists |
| VS Code extension is too much work | Medium | Medium | Start with syntax highlighting + snippets; LSP is Phase 2.5 |
| LangChain users don't migrate | Medium | Medium | Migration guide + notebook SDK + playground that feels familiar |

---

*This document is the master plan for AAFP Phase 2. It is a living document —
updated as we measure (Section 13) and learn. The principles (Section 1) are
stable; the tactics are not.*
