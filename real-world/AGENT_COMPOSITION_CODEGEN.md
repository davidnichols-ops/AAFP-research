# Agent Composition & Code Generation for AAFP

**Author:** Devin (research synthesis)
**Date:** 2026-07-04
**Status:** Reference design — companion to `LLM_AGENT_INTEGRATION.md`,
`SCG_D1_D2_DESCRIPTOR_QUERY.md`, and `TS_PHASE_7_MCP.md`
**Depends on:** `SCG_D1_D2_DESCRIPTOR_QUERY.md` (SemanticCapability),
`TS_PHASE_7_MCP.md` (MCP transport binding + ecosystem adapters),
`LLM_AGENT_INTEGRATION.md` (capability advertisement), RFC-0002 (framing),
RFC-0007 (MCP-over-AAFP transport binding)

---

## Executive Summary

AAFP agents are currently authored by hand: a developer writes a Rust struct
implementing `ServeHandler`, a Python class with `@capability` decorators, or a
TypeScript `ServeBuilder` chain. This works for the SDK examples but does not
scale to the *thousands of agents* vision described in `STRATEGIC_VISION.md`.
To reach that scale, AAFP needs a **declarative agent definition format**
(`.aafp.yaml`), a **code generator** that emits idiomatic scaffolding for
Rust / Python / TypeScript, a **template library** (echo, LLM, translator,
pipeline), and **composition primitives** (parent/child, pipelines, meshes,
inheritance, mixins). On top of that, a **visual agent builder** (n8n/Zapier
style but AAFP-native) and a **procedural generation** path let non-programmers
and programs themselves assemble agents.

This document specifies all of the above. It defines a concrete `.aafp.yaml`
schema, shows generated code in three languages, enumerates four canonical
templates, four composition patterns, the visual builder data model, a
recommendation on whether AAFP needs a domain-specific language (spoiler: yes,
but a thin one layered over YAML + codegen), procedural agent generation, an
inheritance/mixin capability model, and per-target code generation (server,
client, relay, test). Every section ends with a concrete schema or code
example grounded in the existing SDK APIs (`Agent.serve()`,
`client.discover(cap).call()`, `AafpMcpTransport`, `McpToolBridge`).

**Key conclusion:** AAFP should treat agent definitions as a *first-class
artifact* — versioned, signed, publishable to the DHT, and compilable to
native code in three languages. The `.aafp.yaml` file is to AAFP what
`Dockerfile` is to containers: a declarative blueprint that an engine
materializes into a running, addressable, post-quantum-identified agent.

---

## 1. Agent Definition Files (`.aafp.yaml`)

### 1.1 Why a Declarative Format

Hand-writing agents has three problems at scale:

1. **Boilerplate explosion.** Every agent repeats the same keypair load,
   `ServeBuilder` chain, capability registration, logging setup, metrics
   exporter, and graceful-shutdown logic. Across 1,000 agents this is tens of
   thousands of lines of copy-pasted scaffolding.
2. **No portable artifact.** A Rust agent and a Python agent that do the
   same thing share no common description. Operators cannot audit, diff, or
   inventory agents without reading source.
3. **No machine composition.** A visual builder or a procedural generator
   needs a serializable intermediate representation, not free-form source
   code.

A declarative `.aafp.yaml` solves all three: it is the single source of truth,
it is language-agnostic, and it is the IR for both the visual builder and the
code generator.

### 1.2 Design Principles

- **Declarative, not imperative.** The file describes *what* the agent is
  (identity, capabilities, mixins, target) not *how* it runs (no inline
  business logic beyond small handler stubs and templates).
- **Signed.** The file carries an `AgentId` (ML-DSA-65 public key hash) and an
  optional detached signature so the DHT can verify that a published agent
  definition matches the key that advertised it.
- **Versioned.** `schema_version` is mandatory. The code generator refuses
  unknown versions.
- **Target-aware.** One file can generate a server, a client, a relay, or a
  test harness depending on the `target` field and the `--target` CLI flag.
- **Composable.** `extends`, `mixins`, and `composition` fields reference
  other `.aafp.yaml` files by name, enabling inheritance and reuse.
- **Round-trippable.** The visual builder reads and writes the exact same
  format the code generator consumes. No lossy conversion.

### 1.3 Concrete Schema

The schema is YAML with a JSON Schema twin for validation. Below is the full
top-level shape; subsequent sections drill into each field.

```yaml
# echo-agent.aafp.yaml
schema_version: 1
name: echo-agent
description: Minimal agent that echoes request bodies back to the caller.
version: 0.1.0
author: devin@example.com
license: Apache-2.0

identity:
  agent_id: "0x9f3a...c1e2"        # ML-DSA-65 public key hash (hex)
  keypair_file: "./keys/echo.pqkey" # generated via `aafp keygen`
  # If absent, `aafp build` generates a new keypair and writes it.

target: server                      # server | client | relay | test
language: rust                      # rust | python | typescript
runtime:
  bind: "127.0.0.1:4433"
  max_concurrent_streams: 256
  idle_timeout_ms: 30000

capabilities:
  - name: "echo"
    description: "Echo the request body back to the caller."
    streaming: false
    params:
      - key: 1
        type: string
        name: text
        required: true
    returns:
      - key: 1
        type: string
        name: echoed

mixins:
  - logging
  - metrics

composition: ~                      # none for a leaf agent

metadata:
  tags: [demo, minimal]
  cost:
    per_call_micro_usd: 0
```

### 1.4 Field Reference

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `schema_version` | int | yes | Currently `1`. |
| `name` | string | yes | DNS-label-safe; used as crate/package/module name. |
| `description` | string | no | Human-readable; published in `AgentRecord`. |
| `version` | semver | yes | App version, not schema version. |
| `identity.agent_id` | hex | yes* | `*` auto-generated if `keypair_file` absent. |
| `identity.keypair_file` | path | no | Created by `aafp keygen` if missing. |
| `target` | enum | yes | `server`/`client`/`relay`/`test`. |
| `language` | enum | yes | `rust`/`python`/`typescript`. |
| `runtime.bind` | addr | server/relay only | `host:port` for QUIC listener. |
| `runtime.max_concurrent_streams` | int | no | Default 256. |
| `capabilities[]` | list | server/relay only | See §1.5. |
| `mixins[]` | list | no | Names from the mixin registry (§7). |
| `composition` | object | no | Parent/pipeline/mesh spec (§5). |
| `metadata` | map | no | Free-form; merged into `AgentRecord.metadata`. |

### 1.5 Capability Sub-Schema

Each capability entry mirrors the `SemanticCapability` struct from
`SCG_D1_D2_DESCRIPTOR_QUERY.md` so the generator can emit both the handler
stub *and* the DHT advertisement:

```yaml
capabilities:
  - name: "translate"
    description: "Translate text between languages."
    streaming: true                 # server-streaming (RFC-0002 §4.1 MORE flag)
    category: "nlp"
    attributes:
      languages: ["en", "fr", "de", "ja"]
      model: "claude-3.5-sonnet"
    params:
      - key: 1
        type: string
        name: text
        required: true
      - key: 2
        type: string
        name: source_lang
        required: false
      - key: 3
        type: string
        name: target_lang
        required: true
    returns:
      - key: 1
        type: string
        name: translated
    cost:
      per_call_micro_usd: 200
    dependencies:
      - capability: "llm.chat"
        required: true
```

The `dependencies` field feeds both the code generator (which emits a
`client.discover("llm.chat")` call) and the DHT publisher (which records the
dependency edge in the capability dependency graph from SCG-D1).

---

## 2. Code Generation from Agent Definitions

### 2.1 The `aafp` CLI

A single CLI drives the lifecycle:

```bash
aafp keygen --out keys/echo.pqkey        # generate ML-DSA-65 keypair
aafp validate echo-agent.aafp.yaml       # schema + semantic checks
aafp build echo-agent.aafp.yaml          # emit scaffolding into ./generated/
aafp run   echo-agent.aafp.yaml          # build + compile + execute
aafp publish echo-agent.aafp.yaml        # sign + push AgentRecord to DHT
```

`aafp build` is the core. It reads the YAML, resolves `extends`/`mixins`,
and emits a language-specific project tree:

```
generated/echo-agent/
  Cargo.toml          # or pyproject.toml / package.json
  src/
    main.rs           # entrypoint: load keypair, bind, serve
    handlers.rs       # capability handler stubs (user fills in)
    capabilities.rs   # SemanticCapability + AgentRecord builder
    mixins.rs         # generated mixin wiring (logging, metrics)
  echo-agent.aafp.yaml  # copied for traceability
  .agent-signature     # detached ML-DSA-65 signature of the YAML
```

The generated code is **compilable and runnable as-is** for the echo template;
for LLM/translator/pipeline templates the handler bodies contain clearly
marked `// TODO: implement` regions plus a working default that calls the
declared `dependencies`.

### 2.2 Generated Rust (Server)

Given the `echo-agent.aafp.yaml` above, `aafp build --language rust` emits:

```rust
// generated/echo-agent/src/main.rs
use aafp::{Agent, ServeBuilder, Request, Response, Params, HandlerContext};
use aafp_identity::AgentKeypair;
use std::sync::Arc;

mod handlers;
mod capabilities;
mod mixins;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let keypair = AgentKeypair::load_file("./keys/echo.pqkey")?;
    let agent_id = keypair.agent_id();

    let mut builder = ServeBuilder::new(Arc::new(keypair))
        .bind("127.0.0.1:4433")
        .max_concurrent_streams(256)
        .idle_timeout(std::time::Duration::from_millis(30000));

    // Mixin wiring (generated from mixins: [logging, metrics])
    builder = mixins::apply_logging(builder);
    builder = mixins::apply_metrics(builder);

    // Capability registration (generated from capabilities: [...])
    builder = builder
        .capability("echo")
        .on_capability("echo", handlers::echo);

    let agent = builder.start().await?;
    println!("echo-agent serving at {}", agent.local_addr());
    agent.await_terminated().await;
    Ok(())
}
```

```rust
// generated/echo-agent/src/handlers.rs
use aafp::{Request, Response, Params, HandlerContext};

/// Capability: echo
///   params[1] (str, required): text
///   returns[1] (str): echoed
pub async fn echo(req: Request, _ctx: HandlerContext) -> Response {
    let text = req.params.get_str(1).unwrap_or_default();
    Response::with_result(Params::create().put_str(1, text))
}
```

```rust
// generated/echo-agent/src/capabilities.rs
use aafp_identity::{SemanticCapability, CapabilityAttribute, AgentRecord};

pub fn build_agent_record(agent_id: &str, addr: &str) -> AgentRecord {
    let echo = SemanticCapability::builder("echo")
        .description("Echo the request body back to the caller.")
        .category("demo")
        .streaming(false)
        .cost_per_call_micro_usd(0)
        .build();
    AgentRecord::builder(agent_id, addr)
        .capability(echo)
        .tag("demo")
        .tag("minimal")
        .build()
}
```

### 2.3 Generated Python (Server)

```python
# generated/echo_agent/main.py
import asyncio
from aafp import Agent, Request, Response, Params
from aafp.identity import AgentKeypair, SemanticCapability

async def echo(req: Request, _ctx) -> Response:
    """Capability: echo. params[1]=text -> returns[1]=echoed."""
    text = req.params.get_str(1) or ""
    return Response.with_result(Params.create().put_str(1, text))

async def main():
    keypair = AgentKeypair.load_file("./keys/echo.pqkey")
    agent = (
        Agent.serve(keypair)
        .bind("127.0.0.1:4433")
        .max_concurrent_streams(256)
        .capability("echo", echo)
        # mixins applied via decorators (see §7.2)
        .apply_mixin("logging")
        .apply_mixin("metrics")
        .start()
    )
    print(f"echo-agent serving at {agent.local_addr}")
    await agent.wait_terminated()

if __name__ == "__main__":
    asyncio.run(main())
```

### 2.4 Generated TypeScript (Server)

```typescript
// generated/echo-agent/src/main.ts
import { Agent, Request, Response, Params } from "@aafp/sdk";
import { AgentKeypair } from "@aafp/sdk/identity";

async function echo(req: Request, _ctx: unknown): Promise<Response> {
  const text = req.params.getStr(1) ?? "";
  return Response.withResult(Params.create().putStr(1, text));
}

async function main() {
  const keypair = AgentKeypair.loadFile("./keys/echo.pqkey");
  const agent = await Agent.serve(keypair)
    .bind("127.0.0.1:4433")
    .maxConcurrentStreams(256)
    .capability("echo")
    .onCapability("echo", echo)
    .start();
  console.log(`echo-agent serving at ${agent.localAddr}`);
  await agent.terminated();
}

main();
```

### 2.5 Generator Architecture

The generator is a pipeline of pure transforms over an intermediate
representation (`AgentSpec`) derived from the YAML:

```
.aafp.yaml
   │  parse + validate (JSON Schema)
   ▼
AgentSpec { identity, target, language, capabilities, mixins, composition }
   │  resolve extends/mixins (merge)
   ▼
AgentSpec (fully merged)
   │  target pass: server | client | relay | test
   ▼
TargetSpec
   │  language pass: rust | python | typescript
   ▼
LanguageProject { files: Vec<FileSpec> }
   │  write to disk
   ▼
generated/<name>/
```

Each pass is a pure function `AgentSpec -> AgentSpec`, making the generator
testable, deterministic, and cacheable (a content hash of the merged
`AgentSpec` determines whether regeneration is needed).

---

## 3. Agent Templates

Templates are prebuilt `.aafp.yaml` + handler implementations that cover the
80% case. `aafp new --template llm` scaffolds a working agent from a template.

### 3.1 Echo Agent

The simplest agent. Used for testing, demos, and as the "hello world" of
AAFP. Shown in full in §1.3 and §2. The handler is one line: return the
request body verbatim.

### 3.2 LLM Agent

Wraps a frontier LLM (OpenAI, Anthropic) as an AAFP `text-generation`
capability, exactly as specified in `LLM_AGENT_INTEGRATION.md`. The template
emits the streaming handler, cost tracking, and fallback-chain wiring.

```yaml
# llm-agent.aafp.yaml (template)
schema_version: 1
name: llm-chat
version: 0.1.0
target: server
language: python
runtime:
  bind: "0.0.0.0:4433"
capabilities:
  - name: "text-generation"
    streaming: true
    category: "nlp"
    attributes:
      model: "claude-3.5-sonnet"
      provider: "anthropic"
    params:
      - { key: 1, type: string, name: prompt, required: true }
      - { key: 2, type: string, name: system, required: false }
    returns:
      - { key: 1, type: string, name: completion }
    cost:
      per_call_micro_usd: 5000
    dependencies:
      - capability: "anthropic.messages"
        required: true
mixins: [logging, metrics, rate_limit, cost_tracker]
metadata:
  tags: [llm, anthropic]
```

The generated handler streams tokens via AAFP server-streaming RPC (the MORE
flag from RFC-0002 §4.1), reports token usage in the final frame, and updates
the `AgentRecord` cost extension so the DHT reflects live pricing.

### 3.3 Translator Agent

A specialization of the LLM agent with a fixed prompt template and a
`translate` capability. Demonstrates *template inheritance*: the translator
template `extends: llm-agent` and overrides only the capability name, the
system prompt, and the param schema.

```yaml
schema_version: 1
name: translator
extends: llm-agent
capabilities:
  - name: "translate"
    streaming: true
    params:
      - { key: 1, type: string, name: text, required: true }
      - { key: 2, type: string, name: source_lang, required: false }
      - { key: 3, type: string, name: target_lang, required: true }
    returns:
      - { key: 1, type: string, name: translated }
    dependencies:
      - capability: "text-generation"
        required: true
```

### 3.4 Pipeline Agent

An agent whose handler chains multiple sub-capabilities. See §5.2 for the
composition spec; the template provides the fan-out/fan-in handler skeleton.

### 3.5 Template Registry

Templates live in a registry (a Git repo or OCI artifact) keyed by name:

| Template | Base | Adds |
|----------|------|------|
| `echo` | — | trivial echo handler |
| `llm` | — | streaming LLM wrapper, cost tracking, fallback |
| `translator` | `llm` | fixed translation prompt, lang params |
| `pipeline` | — | multi-stage fan-out/fan-in handler |
| `relay` | — | transparent forwarder (§6.3) |
| `mcp-bridge` | — | `McpToolBridge` wiring (TS_PHASE_7 Part 2) |
| `web-browse` | — | Firecrawl-backed `web-browse` capability |

`aafp new --template mcp-bridge` emits the TypeScript from TS_PHASE_7 Part 2
with the MCP server connection pre-wired.

---

## 4. Composition Patterns

Composition is how agents are built from other agents. AAFP supports four
first-class patterns, all expressible in the `composition` field of
`.aafp.yaml`.

### 4.1 Parent Agent Spawning Children

A parent agent holds a client connection and spawns child agents on demand
(e.g., one per incoming request, or one per tenant). The parent advertises a
capability; its handler dials a child agent (discovered via DHT or spawned
locally), forwards the request, and relays the response.

```yaml
composition:
  kind: parent_children
  children:
    - template: llm
      count: 4                # pool size
      scale: auto             # auto-scale based on queue depth
      spawn_policy: pool      # pool | on_demand | per_request
  forward:
    strategy: round_robin     # round_robin | least_loaded | random
    fallback:
      - capability: "text-generation"
        on_error: [timeout, unavailable]
```

Generated parent handler (Rust sketch):

```rust
pub async fn chat(req: Request, ctx: HandlerContext) -> Response {
    let child = ctx.pool.acquire().await;          // round-robin pool
    let res = child.call("text-generation", req).await;
    match res {
        Ok(r) => r,
        Err(e) => ctx.fallback.call("text-generation", req).await,
    }
}
```

### 4.2 Agent Pipelines

A pipeline agent chains N stages, each a capability call. Stage *i*'s output
feeds stage *i+1*'s input. This is the AAFP analog of a Unix pipe or an n8n
workflow.

```yaml
composition:
  kind: pipeline
  stages:
    - name: fetch
      capability: "web-browse"
      params: { url: "${1}" }       # ${k} references input param key
    - name: extract
      capability: "html-to-text"
      params: { html: "${fetch.1}" }
    - name: summarize
      capability: "text-generation"
      params: { prompt: "${extract.1}", system: "Summarize in 3 bullets." }
```

The `${stage.key}` interpolation is resolved by the generated pipeline
orchestrator at runtime. Each stage is a normal `client.discover(cap).call()`,
so stages can be satisfied by any agent in the DHT — the pipeline is
*location-transparent*.

### 4.3 Agent Meshes

A mesh agent fans a request out to *many* agents in parallel and aggregates
the results. Use cases: ensemble LLM calls (ask 3 models, majority vote),
redundant fetches (ask 3 web-browse agents, first response wins), or
sharded computation.

```yaml
composition:
  kind: mesh
  fanout:
    capability: "text-generation"
    count: 3
    selection: top_rated          # top_rated | random | geo_nearest
  aggregate:
    strategy: first_success       # first_success | majority_vote | all
    timeout_ms: 5000
```

### 4.4 Router / Dispatcher

A router inspects the request and dispatches to one of several child agents
based on a predicate. This is the AAFP equivalent of an API gateway or a
LangChain router chain.

```yaml
composition:
  kind: router
  routes:
    - when: { param: 3, eq: "fr" }
      to: { capability: "translate.fr" }
    - when: { param: 3, eq: "ja" }
      to: { capability: "translate.ja" }
    - default: { capability: "translate.en" }
```

---

## 5. Visual Agent Builder

### 5.1 Vision

A browser-based drag-and-drop composer for AAFP agents — n8n/Zapier-style but
emitting `.aafp.yaml` and runnable agents, not proprietary workflows. Nodes
are capabilities or composition blocks; edges are data flows (param key
references). The output is a valid `.aafp.yaml` that `aafp build` consumes
unchanged.

### 5.2 Node Types

| Node | Represents | YAML field |
|------|-----------|------------|
| Capability node | a `capabilities[]` entry | `capabilities` |
| Mixin node | a `mixins[]` entry | `mixins` |
| Pipeline stage | one stage in `composition.stages` | `composition.stages` |
| Mesh fan-out | a `composition.fanout` | `composition.fanout` |
| Router branch | a `composition.routes` entry | `composition.routes` |
| Identity node | keypair / agent_id | `identity` |
| Target node | server/client/relay/test | `target` |

### 5.3 Data Model

The builder's internal graph is a DAG of `Node` objects. Each `Node` has
`inputs` and `outputs` keyed by param key, matching the `params`/`returns`
schema. Drawing an edge from node A's output `1` to node B's input `2`
generates `params: { text: "${A.1}" }`. This is exactly the interpolation
syntax from §4.2, so the visual builder is a pure GUI over the same IR.

### 5.4 Live Preview & Test

The builder can `aafp build` and `aafp run` in a sandboxed WASM runtime
(leveraging the browser WebTransport support from TS_PHASE_6) so the user
sees a live, addressable agent before exporting. A "Test" button sends a
sample request through the composed agent and renders the response stream.

### 5.5 Export & Publish

- **Export YAML** — downloads the `.aafp.yaml`.
- **Export code** — runs `aafp build` server-side, downloads the generated
  Rust/Python/TS project.
- **Publish to DHT** — signs the YAML with the agent's keypair and pushes
  the `AgentRecord` to the DHT, making the agent discoverable network-wide.

---

## 6. Agent DSL — Should AAFP Have One?

### 6.1 The Question

Should AAFP define a domain-specific language (DSL) for agent behavior,
analogous to HCL for Terraform or CEL for policies? Or is YAML + generated
code sufficient?

### 6.2 Recommendation: A Thin DSL, Layered

**Yes, but thin.** AAFP should not invent a full programming language. The
recommended layering:

1. **`.aafp.yaml`** — declarative structure (identity, capabilities, mixins,
   composition). No logic.
2. **`aafp.flow`** — a small expression DSL *only* for composition
   interpolation, routing predicates, and aggregate strategies. Embedded in
   YAML as string values (e.g., `when: "param[3] == 'fr'"`).
3. **Generated native code** — for anything the DSL cannot express, the user
   edits the generated handler stubs in Rust/Python/TS.

The DSL (`aafp.flow`) is intentionally limited to:

- Param references: `${stage.key}`, `${input.1}`
- Predicates: `param[3] == "fr"`, `cost < 1000`, `latency_ms < 200`
- Aggregators: `first_success`, `majority_vote`, `min_cost`, `min_latency`
- No loops, no mutation, no I/O — it is a pure expression language.

This keeps the declarative file auditable and safe (no arbitrary code
execution from a YAML string) while removing 90% of the boilerplate that
would otherwise force users into hand-edited generated code.

### 6.3 Why Not a Full DSL

A full DSL (Turing-complete, with its own runtime) would:

- Duplicate effort already solved by Rust/Python/TS.
- Create a security boundary problem (executing untrusted agent logic).
- Fracture the ecosystem (debuggers, profilers, IDE support all need
  rebuilding).

The thin-DSL approach gets the ergonomics without the cost. The escape hatch
is always "edit the generated native code," which keeps the full power of
the host language one step away.

---

## 7. Procedural Agent Generation

### 7.1 Agents That Create Agents

An LLM agent (or any agent) can, at runtime, produce a new `.aafp.yaml` and
deploy it. This is procedural generation: the agent reasons about a task,
decides a new capability is needed, writes the definition, and either
`aafp build && aafp run`s it locally or publishes it to the DHT for another
host to materialize.

### 7.2 The `agent.spawn` Capability

Define a well-known capability `agent.spawn` that accepts a `.aafp.yaml`
document (params key 1 = YAML string) and returns the new agent's address
(params key 1) and agent_id (params key 2). Any agent granted this capability
can create children dynamically.

```yaml
# meta-agent.aafp.yaml
capabilities:
  - name: "agent.spawn"
    params:
      - { key: 1, type: string, name: definition_yaml, required: true }
    returns:
      - { key: 1, type: string, name: agent_addr }
      - { key: 2, type: string, name: agent_id }
```

### 7.3 Safety Guardrails

Procedural generation is powerful but dangerous. The `agent.spawn` handler
MUST enforce:

- **Quota:** max spawned agents per parent (configurable, default 16).
- **Capability allowlist:** spawned agents may only advertise capabilities
  the parent is authorized to grant.
- **Resource limits:** CPU/memory/stream caps on spawned processes.
- **Signature:** the spawned YAML must be signed by the parent's keypair;
  the runtime refuses unsigned or mismatched definitions.
- **TTL:** spawned agents have a maximum lifetime (default 1h) after which
  they self-terminate unless renewed.

### 7.4 Use Case: Self-Improving Pipeline

An LLM agent observes that translation requests for a rare language pair are
slow (high latency in `AgentRecord`). It procedurally generates a
specialized translator agent cached for that pair, publishes it, and updates
its own router (§4.4) to dispatch that pair to the new agent. The network
self-optimizes.

---

## 8. Agent Inheritance

### 8.1 Base + Derived

A derived agent `extends` a base agent, inheriting its identity options,
mixins, capabilities, and composition, then overriding or adding. This is
the YAML analog of class inheritance.

```yaml
# base-llm.aafp.yaml
schema_version: 1
name: base-llm
target: server
language: python
mixins: [logging, metrics, cost_tracker]
capabilities:
  - name: "text-generation"
    streaming: true
    params: [{ key: 1, type: string, name: prompt, required: true }]
    returns: [{ key: 1, type: string, name: completion }]
```

```yaml
# fast-llm.aafp.yaml
schema_version: 1
name: fast-llm
extends: base-llm
capabilities:
  - name: "text-generation"
    attributes: { model: "claude-3.5-haiku" }   # override model only
    cost: { per_call_micro_usd: 500 }
```

### 8.2 Merge Semantics

The generator merges base and derived with these rules:

- Scalars in derived override base.
- Lists (capabilities, mixins) are merged by `name` key: derived entries
  override base entries with the same name; new entries are appended.
- Maps (attributes, metadata) are deep-merged.
- `identity` is never inherited — every concrete agent has its own keypair.

---

## 9. Agent Mixins

### 9.1 Composable Capability Sets

Mixins are cross-cutting concerns applied to any agent without repeating
code. A mixin is a named bundle of: handler middleware, `AgentRecord`
metadata, and optional dependencies. The generator emits the wiring.

| Mixin | What it adds |
|-------|-------------|
| `logging` | structured per-request logs (capability, agent_id, latency) |
| `metrics` | Prometheus exporter: request count, latency histogram |
| `auth` | require caller authorization via `AuthorizationProvider` |
| `rate_limit` | token-bucket per-caller rate limiting |
| `cost_tracker` | accumulate token/cost usage into `AgentRecord` extensions |
| `tracing` | OpenTelemetry spans per capability call |
| `retry` | automatic retry with backoff on transient errors |
| `circuit_breaker` | trip on N failures, half-open probe (AR-T3) |

### 9.2 Mixin Definition Format

```yaml
# mixins/logging.aafp.mixin.yaml
name: logging
version: 1
applies_to: [server, relay]
middleware:
  before: "log_request"
  after: "log_response"
metadata:
  adds_tags: [observed]
```

### 9.3 Generated Mixin Wiring (Rust)

```rust
// generated/echo-agent/src/mixins.rs
use aafp::ServeBuilder;

pub fn apply_logging(builder: ServeBuilder) -> ServeBuilder {
    builder.middleware(|req, next| async move {
        let cap = req.capability.clone();
        let start = std::time::Instant::now();
        let res = next(req).await;
        tracing::info!(capability = %cap, latency_us = start.elapsed().as_micros());
        res
    })
}

pub fn apply_metrics(builder: ServeBuilder) -> ServeBuilder {
    builder.middleware(|req, next| async move {
        METRICS.requests.inc();
        let res = next(req).await;
        if res.is_ok() { METRICS.successes.inc(); }
        res
    })
}
```

### 9.4 Mixin Composition Order

Mixins are applied in declared order, forming an onion: the first declared
is the outermost. `mixins: [logging, metrics, auth]` means logging wraps
metrics wraps auth wraps the handler. This is deterministic and auditable.

---

## 10. Code Generation for Different Targets

The `target` field selects which runtime shape the generator emits. One
`.aafp.yaml` can be built for multiple targets via `aafp build --target test`.

### 10.1 Server Agent

The default. Binds a QUIC listener, performs the AAFP v1 handshake on
inbound connections, registers capabilities, and serves RPC. Shown in §2.

### 10.2 Client Agent

A client agent does not bind a listener. It loads a keypair, connects to a
peer (or discovers via DHT), and calls capabilities. Generated from the same
YAML but with `target: client`:

```typescript
// generated/echo-client/src/main.ts
import { Agent, Request, Params } from "@aafp/sdk";

async function main() {
  const client = await Agent.connect();
  const peer = await client.discover("echo");
  const res = await peer.call(
    Request.withParams(Params.create().putStr(1, "hello")),
  );
  console.log(res.params.getStr(1)); // "hello"
}
main();
```

### 10.3 Relay Agent

A relay forwards requests from one agent to another, optionally transforming
them. This is the AAFP-native API gateway / sidecar. The relay template
emits a transparent forwarder that re-signs requests with its own identity
and can apply mixins (auth, rate_limit, logging) as a policy enforcement
point.

```yaml
# relay.aafp.yaml
target: relay
language: rust
runtime: { bind: "0.0.0.0:4433" }
composition:
  kind: relay
  upstream:
    discovery: "text-generation"   # discover and forward to this capability
    re_sign: true                  # sign with relay's own keypair
mixins: [auth, rate_limit, logging]
```

### 10.4 Test Agent

A test target generates a harness that spins up the agent in-process, sends
canned requests, and asserts on responses. This is what `aafp test` runs.

```rust
// generated/echo-agent/tests/echo_test.rs (target: test)
#[tokio::test]
async fn echo_roundtrip() {
    let agent = test_harness::start("echo-agent.aafp.yaml").await;
    let client = agent.connect_local().await;
    let res = client.call("echo",
        Request::with_params(Params::create().put_str(1, "hi"))).await.unwrap();
    assert_eq!(res.params.get_str(1), Some("hi"));
}
```

The test target also generates fuzz inputs from the `params` schema and
property-based tests (e.g., "echo always returns input unchanged for any
string").

---

## 11. MCP Integration in Generated Agents

The MCP integration from `TS_PHASE_7_MCP.md` plugs directly into the codegen
pipeline. Two mixin/template combinations cover the common cases.

### 11.1 Exposing MCP Tools as AAFP Capabilities

The `mcp-bridge` template (§3.5) emits the `McpToolBridge` wiring from
TS_PHASE_7 Part 2. The `.aafp.yaml` declares the MCP server address and the
capability prefix; the generator emits the TypeScript bridge, the
`AafpMcpTransport.accept()` loop, and the `*.call` / `*.list` capability
handlers.

```yaml
name: fs-mcp-bridge
target: server
language: typescript
capabilities:
  - name: "fs.call"
    description: "Call an MCP filesystem tool."
  - name: "fs.list"
    description: "List MCP filesystem tools."
mcp:
  server_command: ["npx", "@modelcontextprotocol/server-filesystem", "/data"]
  cap_prefix: "fs"
mixins: [logging, metrics]
```

### 11.2 Calling MCP Tools from a Generated Agent

A generated LLM agent that needs tool-use can declare an MCP dependency; the
generator emits a `dialMcp()` call plus an `McpToolBridge` client so the
agent's handler can invoke MCP tools via the normal AAFP `discover().call()`
API (TS_PHASE_7 Part 4, Option A). The agent never imports the MCP SDK
directly — the bridge abstracts it.

### 11.3 LangChain / Vercel AI Adapters as Targets

Because the adapters from TS_PHASE_7 Parts 6–7 are just `@aafp/sdk`
subpath exports, a generated agent can be wrapped as a LangChain tool or a
Vercel AI provider by adding `adapters: [langchain, vercel-ai]` to the YAML.
The generator emits the adapter glue (`AafpTool` / `AafpLanguageModel`)
alongside the core agent, producing a publishable `@aafp/langchain` package
from the same definition.

---

## 12. Publishing & Discovery

### 12.1 Signed Definitions

`aafp publish` signs the merged `AgentSpec` (canonical CBOR encoding) with
the agent's ML-DSA-65 keypair and attaches the signature as a
`.agent-signature` sidecar. The DHT stores the `AgentRecord` (built from
`capabilities.rs`) keyed by `SHA-256(capability_name)` per SCG-D1. Consumers
can fetch the signed definition, verify it against the advertised `agent_id`,
and reproduce the exact binary via `aafp build`.

### 12.2 Reproducible Builds

The merged `AgentSpec` has a content hash. `aafp build` is deterministic
(file ordering, no timestamps), so `hash(spec) -> hash(generated project)`
is stable. This enables supply-chain attestation: a verifier can confirm
that a running agent matches its published, signed definition.

---

## 13. End-to-End Example: A Translation Mesh

Combining inheritance, mixins, composition, and MCP bridging into one
deployable system.

```yaml
# translate-mesh.aafp.yaml
schema_version: 1
name: translate-mesh
version: 0.2.0
target: server
language: rust
extends: base-llm
mixins: [logging, metrics, auth, circuit_breaker]
runtime: { bind: "0.0.0.0:4433", max_concurrent_streams: 512 }
composition:
  kind: mesh
  fanout:
    capability: "translate"
    count: 3
    selection: top_rated
  aggregate:
    strategy: majority_vote
    timeout_ms: 8000
capabilities:
  - name: "translate"
    streaming: true
    params:
      - { key: 1, type: string, name: text, required: true }
      - { key: 3, type: string, name: target_lang, required: true }
    returns:
      - { key: 1, type: string, name: translated }
    dependencies:
      - capability: "text-generation"
        required: true
mcp:
  tools: ["glossary.lookup"]      # optional MCP glossary tool
metadata:
  tags: [translation, mesh, ensemble]
```

Build, run, publish:

```bash
aafp keygen --out keys/translate.pqkey
aafp build translate-mesh.aafp.yaml
aafp run   translate-mesh.aafp.yaml      # serving at quic://0.0.0.0:4433
aafp publish translate-mesh.aafp.yaml    # AgentRecord in DHT
```

Any AAFP client can now `discover("translate")` and reach the mesh, which
fans out to three top-rated translators, majority-votes the result, and
optionally consults an MCP glossary tool — all from one declarative file.

---

## 14. Open Questions

1. **Hot reload.** Should `aafp run` watch the `.aafp.yaml` and re-generate
   + restart on change? Likely yes for dev; production uses blue-green.
2. **Cross-language composition.** Can a Rust parent spawn a Python child
   via `agent.spawn`? Yes — the child's YAML declares its own `language`;
   the parent's runtime invokes `aafp build && aafp run` for that language.
3. **Mixin versioning.** If `logging` mixin v2 changes behavior, how do
   deployed agents pin? Mixin YAML carries `version`; the generator records
   the resolved version in the spec hash.
4. **Visual builder backend.** Should the builder be a pure client-side WASM
   app (no server) or a hosted service? Pure WASM aligns with AAFP's
   decentralized ethos; a hosted service is faster to ship.
5. **DSL formal grammar.** The `aafp.flow` expression syntax needs a formal
   grammar and a reference interpreter (likely embedded in the generator,
   not the agent runtime).

---

## 15. References

- `TS_PHASE_7_MCP.md` — MCP transport binding, `McpToolBridge`,
  `McpResourceBridge`, LangChain & Vercel AI adapters
- `SCG_D1_D2_DESCRIPTOR_QUERY.md` — `SemanticCapability` struct, capability
  dependency graph, DHT keying
- `LLM_AGENT_INTEGRATION.md` — LLM wrapper agents, capability advertisement,
  cost tracking, fallback chains
- `RFC-0002` — AAFP framing, DATA frames, MORE flag for streaming
- `RFC-0007` — MCP-over-AAFP transport binding (mandatory/prohibited reqs)
- `STRATEGIC_VISION.md` — thousands-of-agents scale, open graph thesis
- n8n: https://n8n.io (visual workflow composition reference)
- Zapier: https://zapier.com (trigger/action composition reference)
- Terraform HCL: https://developer.hashicorp.com/terraform/language (thin
  DSL reference)
- CEL (Common Expression Language): https://github.com/google/cel-spec
  (embedded expression language reference)
