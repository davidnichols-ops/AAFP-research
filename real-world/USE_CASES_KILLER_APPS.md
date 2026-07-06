# AAFP Use Cases & Killer Apps

**Author:** Devin (research synthesis)
**Date:** 2026-07-04
**Status:** Reference catalog for ecosystem development
**Prerequisite docs:** STRATEGIC_VISION.md, INTERNET_BRIDGE_PLAN.md

---

## Purpose

This document catalogs 15+ concrete use cases that demonstrate AAFP's value
as the **decentralized execution substrate for autonomous software**. Each use
case is grounded in the architecture described in STRATEGIC_VISION.md (the
agent operating system stack) and INTERNET_BRIDGE_PLAN.md (the World
Perception Layer). For every use case we specify:

- **Agent topology** — the shape of the agent graph
- **Capabilities needed** — well-known capabilities and custom ones
- **Data flow** — how work moves through the network
- **AAFP features used** — which protocol/stack features are load-bearing

The goal is to make concrete what "an adaptive, capability-aware,
self-optimizing network where agents discover, trust, schedule, migrate, and
coordinate work" actually looks like in production.

---

## How to Read This Document

Each use case is self-contained. The recurring AAFP features referenced are:

| Feature | Source | Role |
|---------|--------|------|
| DHT discovery | RFC-0008 | Semantic capability lookup, URL frontiers, seen-sets |
| PubSub | RFC-0009 | Real-time event broadcast, streaming results |
| UCAN tokens | RFC-0005 | Capability delegation, scoped authority |
| TrustManager | RFC-0011 | Credential storage, reputation scoring |
| Adaptive Routing Plane | Phase 2 (Track T) | Resource-aware routing |
| Semantic Capability Graphs | Phase 3 (Track U) | Graph-based discovery |
| Execution Fabric | Phase 4 (Track V) | Pipeline assembly, checkpointing |
| Agent Reputation | Phase 5 (Track W) | Performance-weighted selection |
| Economic Layer | Phase 7 (Track Y) | Resource accounting, compensation |
| World Perception Layer | INTERNET_BRIDGE_PLAN | web-browse, search, document-read, etc. |
| Agent-native content schema | RFC-0016 | Structured content representation |
| Stateful browsing sessions | RFC-0017 | Multi-agent browser session sharing |
| Distributed rate limiting | RFC-0015 | Collective DDoS prevention |

---

## Use Case 1: Distributed AI Research Lab

### Concept

A federated research lab where independent agents owned by different
organizations share GPU compute, datasets, and trained models without a
central scheduler. Researchers submit experiments; the network assembles
the execution pipeline automatically.

### Agent Topology

```
                    ┌─────────────────┐
                    │  Researcher     │
                    │  Agent (client) │
                    └────────┬────────┘
                             │ submit experiment spec
                             ▼
              ┌──────────────────────────────┐
              │  Execution Fabric Scheduler  │
              │  (any node, elected per job) │
              └──────┬───────────┬───────────┘
                     │           │
        ┌────────────▼───┐   ┌──▼───────────────┐
        │  GPU Provider  │   │  Dataset Provider │
        │  Agents (N)    │   │  Agents (M)       │
        │  advertise:    │   │  advertise:       │
        │  - CUDA/TPU    │   │  - dataset hashes │
        │  - VRAM free   │   │  - license terms  │
        │  - $/hour      │   │  - schema         │
        └────────────────┘   └───────────────────┘
                     │
              ┌──────▼───────┐
              │ Model Registry│
              │ Agent        │
              │ (DHT-backed) │
              └──────────────┘
```

### Capabilities Needed

- `gpu.train` — fine-tune or train a model on provided data
- `gpu.infer` — run inference against a model
- `dataset.serve` — stream training data with license enforcement
- `model.store` / `model.fetch` — content-addressed model storage
- `experiment.log` — append-only experiment tracking
- `code-execute` — run preprocessing scripts in sandbox

### Data Flow

1. Researcher agent publishes an experiment spec to the DHT under a
   semantic capability query: `gpu.train + H100 + >=80GB VRAM + trust>90`.
2. The Execution Fabric Scheduler (elected via DHT leader election for this
   job) assembles a pipeline: dataset provider → preprocessing agent →
   training agent → evaluation agent → model registry.
3. Dataset provider streams shards via chunked transfer (RFC chunked
   encoding, MORE flag) to the training agent. License terms are enforced
   via UCAN: the training agent receives a scoped token that permits
   "use for experiment {id}, expires in 24h, no redistribution."
4. Training agent checkpoints state every N steps to the Execution Fabric.
   If the GPU node dies mid-training, the scheduler migrates the
   checkpoint to another GPU provider and resumes — **stateful mobility**.
5. Final model is hashed and published to the model registry (DHT key:
   `SHA-256(weights)`). Evaluation agents pull it and publish metrics to
   the experiment log.
6. Reputation updates: providers that completed jobs successfully see
   their trust score rise; failed nodes lose reputation.

### AAFP Features Used

- **Semantic Capability Graphs** — the query "H100, 80GB, trust>90" is a
  graph query, not a string lookup.
- **Execution Fabric** — pipeline assembly and checkpoint/migration.
- **Stateful Mobility** — training survives node failure.
- **UCAN delegation** — dataset license enforcement without a central
  licensing server.
- **Agent Reputation** — provider selection weighted by historical
  success rate and latency.
- **Economic Layer** — `$hour` field in capability advertisements; the
  scheduler optimizes for cost/quality tradeoffs.
- **DHT** — model registry and experiment log are DHT-backed.
- **Chunked transfer + compression** — large dataset/model transfer.

### Why This Is a Killer App

Today, distributed training across organizations requires either a central
scheduler (Kubernetes + Slurm) or manual coordination. AAFP makes it
**declarative**: "I need 4 H100s with trust>90 to train this model on this
dataset." The network handles the rest. This is impossible with HTTP and
cloud APIs alone because there is no shared trust, discovery, or mobility
layer.

---

## Use Case 2: Customer Support Mesh

### Concept

A customer support system where multiple vendors' agents collaborate on a
single ticket. The user's issue might span a billing problem (Stripe),
a bug (the SaaS app), and an integration failure (Zapier). Instead of
bouncing the customer between support queues, agents from each vendor
investigate in parallel and converge on a resolution.

### Agent Topology

```
                 ┌──────────────┐
                 │  Customer    │
                 │  (human)     │
                 └──────┬───────┘
                        │ chat
                        ▼
              ┌──────────────────┐
              │  Triage Agent    │
              │  (classifies,    │
              │   routes)        │
              └──┬─────┬─────┬───┘
                 │     │     │
          ┌──────▼┐ ┌──▼───┐ ┌▼────────┐
          │Vendor │ │Vendor│ │Vendor   │
          │A Agent│ │B Agent│ │C Agent  │
          │(SaaS) │ │(Pay) │ │(Integ)  │
          └──┬────┘ └──┬───┘ └──┬──────┘
             │         │        │
             └────┬────┴────────┘
                  ▼
          ┌───────────────┐
          │ Resolution    │
          │ Agent         │
          │ (synthesizes) │
          └───────────────┘
```

### Capabilities Needed

- `support.triage` — classify ticket, identify involved vendors
- `support.investigate` — vendor-specific diagnostic (each vendor agent
  exposes this with its own internal logic)
- `api-call` — call vendor APIs (Stripe, GitHub, Zapier) via TrustManager
- `web-browse` — read public docs/knowledge bases
- `support.resolve` — propose a resolution action
- `notify.customer` — stream updates back to the customer

### Data Flow

1. Customer describes the problem in natural language. The triage agent
   (discovered via `support.triage` capability) classifies it and
   identifies candidate vendors.
2. Triage agent issues **parallel RPC** calls to each vendor's support
   agent. Each vendor agent investigates independently — querying its own
   systems via `api-call`, reading docs via `web-browse`, checking logs.
3. Vendor agents publish findings to a **PubSub topic**
   (`ticket:{id}:findings`). All participants subscribe.
4. When all vendor agents have reported (or a timeout fires), the
   resolution agent synthesizes a proposed fix. If the fix requires
   actions from multiple vendors (e.g., "refund in Stripe + patch bug in
   SaaS + reconnect in Zapier"), it issues **UCAN-delegated action
   tokens** to each vendor agent authorizing the specific action.
5. Each vendor agent executes its action and reports success/failure to
   the PubSub topic. The resolution agent confirms to the customer.

### AAFP Features Used

- **PubSub** — real-time findings broadcast across vendor agents.
- **UCAN delegation** — scoped action authorization ("Stripe agent may
  issue refund up to $50 for ticket {id}, expires in 1h").
- **Semantic discovery** — triage agent discovers vendor support agents
  by capability (`support.investigate + vendor=stripe`), not hardcoded
  endpoints.
- **TrustManager** — vendor API credentials stored centrally, never
  exposed to other agents.
- **Parallel RPC** — simultaneous investigation reduces resolution time.
- **Agent Reputation** — vendor agents with high resolution rates are
  preferred by the triage agent.

### Why This Is a Killer App

Current multi-vendor support requires the customer to be the integration
layer — repeating their problem to each vendor. AAFP makes the **agents**
the integration layer. The customer states the problem once; agents
collaborate. This is the "personal AI assistant federation" pattern (Use
Case 7) applied to B2B support.

---

## Use Case 3: Code Review Pipeline

### Concept

A multi-stage code review pipeline where specialized agents each handle
one aspect of review — static analysis, security scanning, LLM-based
logic review, and finally human approval — with results streamed in real
time to the developer.

### Agent Topology

```
  PR Created
      │
      ▼
┌──────────┐     ┌──────────────┐     ┌──────────────┐
│ Static   │────▶│ Security     │────▶│ LLM Review   │
│ Analysis │     │ Scan Agent   │     │ Agent        │
│ Agent    │     │ (Semgrep,    │     │ (reads diff, │
│ (clippy, │     │  Snyk)       │     │  comments)   │
│  eslint) │     └──────────────┘     └──────┬───────┘
└──────────┘                                   │
                                               ▼
                                        ┌──────────────┐
                                        │ Human Review │
                                        │ Gate Agent   │
                                        │ (notifies    │
                                        │  reviewer)   │
                                        └──────────────┘
```

### Capabilities Needed

- `code.fetch` — retrieve PR diff from Git provider
- `code.static-analysis` — run linters/type checkers
- `code.security-scan` — vulnerability scanning
- `code.llm-review` — semantic code review via LLM
- `code.comment` — post review comments back to PR
- `notify.human` — request human approval

### Data Flow

1. A webhook triggers the pipeline. The orchestrator agent fetches the
   diff via `api-call` (GitHub/GitLab API, credentials in TrustManager).
2. Static analysis agent runs first. Results stream via **server-streaming
   RPC** to the orchestrator. Critical errors short-circuit the pipeline.
3. Security scan agent runs in parallel with static analysis (independent
   stages). Both publish to PubSub topic `pr:{id}:review`.
4. LLM review agent receives the diff + aggregated findings from prior
   stages. It produces structured review comments (using the agent-native
   content schema to represent code locations as refs).
5. All findings are posted to the PR via `code.comment`. If any agent
   flags a blocker, the human review gate agent is invoked.
6. Human reviewer receives a notification with a **UCAN-delegated token**
   authorizing them to approve/request-changes. Their decision is
   cryptographically signed and recorded.

### AAFP Features Used

- **Streaming RPC** — results stream as they're generated, not after.
- **PubSub** — parallel stage coordination.
- **Execution Fabric** — pipeline assembly (static → security → LLM →
  human) is automatic; the orchestrator declares stages, the fabric
  sequences them.
- **UCAN** — human approval is a delegated capability with audit trail.
- **Agent-native content schema** — code locations represented as refs
  (`@e0` = line 42 of file X), enabling precise multi-agent commenting.
- **api-call + TrustManager** — Git provider auth.

### Why This Is a Killer App

Existing CI/CD systems (GitHub Actions, GitLab CI) are **imperative**:
developers write YAML pipelines. AAFP makes review **declarative**: "review
this PR for static issues, security, and logic." The network assembles the
agent pipeline. New analysis capabilities (e.g., a new SAST tool) just
join the network and become discoverable.

---

## Use Case 4: Real-Time Translation Mesh

### Concept

A mesh of translation agents covering 50+ languages, where any agent can
request translation between any language pair. Direct pairs use a single
agent; rare pairs route through a pivot language (e.g., English or
Chinese) using two agents chained automatically.

### Agent Topology

```
          ┌───────────────────────────────────────┐
          │         Translation Requester         │
          │  "translate(text, src=sw, dst=ja)"    │
          └──────────────────┬────────────────────┘
                             │
                             ▼
              ┌──────────────────────────┐
              │  Translation Router      │
              │  (checks direct path,    │
              │   else pivot via en/zh)  │
              └───┬──────────────┬───────┘
                  │ direct       │ pivoted
                  ▼              ▼
          ┌────────────┐  ┌──────────┐    ┌──────────┐
          │ sw→ja      │  │ sw→en    │───▶│ en→ja    │
          │ Agent      │  │ Agent    │    │ Agent    │
          └────────────┘  └──────────┘    └──────────┘
```

### Capabilities Needed

- `translate.{src}->{dst}` — one capability per language pair (or
  dynamically composed)
- `translate.detect-language` — identify source language
- `translate.pivot` — chain two translators through a pivot

### Data Flow

1. Requester agent issues a translation request with semantic constraints:
   `translate + src=sw + dst=ja + latency<200ms + quality>0.9`.
2. The adaptive routing plane checks the capability graph for a direct
   `sw→ja` agent. If none exists (or none meets constraints), it
   **automatically composes** a pivot path: `sw→en` + `en→ja`.
3. Each leg is a streaming RPC. The first agent's output streams directly
   into the second agent's input (pipeline execution via the Execution
   Fabric).
4. If a higher-quality direct path becomes available mid-translation
   (new agent joins), the router notes it for future requests (learning).
5. Results are cached in the DHT content cache (keyed by
   `SHA-256(text + src + dst)`) so repeated translations are instant.

### AAFP Features Used

- **Semantic Capability Graphs** — language pairs are graph edges;
  routing finds the shortest quality-weighted path.
- **Execution Fabric** — automatic pipeline composition for pivot
  routing.
- **Adaptive Routing Plane** — latency/quality-aware agent selection.
- **DHT content cache** — translation memoization across the network.
- **Streaming RPC** — text streams through the pipeline.
- **Agent Reputation** — translation quality scores feed back into
  routing.

### Why This Is a Killer App

No single provider covers all 7,000+ languages with quality. AAFP enables
a **federated translation network** where specialist agents for rare
languages (e.g., Swahili, Welsh, Quechua) join and instantly become
routable. The pivot composition is automatic — no human wires the
pipeline. This is the "network becomes more capable as agents join"
principle made concrete.

---

## Use Case 5: Autonomous Trading Agents

### Concept

A decentralized trading agent network where specialized agents handle
price discovery, execution, and risk management. No single agent has
full authority; trades require multi-agent consensus on risk.

### Agent Topology

```
  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐
  │ Price       │  │ Execution    │  │ Risk          │
  │ Discovery   │  │ Agent        │  │ Management    │
  │ Agent       │  │ (exchange    │  │ Agent         │
  │ (aggregates │  │  API calls)  │  │ (position     │
  │  feeds)     │  │              │  │  limits,      │
  └──────┬──────┘  └──────┬───────┘  │  exposure)    │
         │                │          └──────┬────────┘
         └────────┬───────┴─────────────────┘
                  ▼
          ┌───────────────┐
          │ Strategy      │
          │ Agent         │
          │ (decides)     │
          └───────┬───────┘
                  │ proposed trade
                  ▼
          ┌───────────────┐
          │ Risk Gate     │
          │ (UCAN check)  │
          └───────────────┘
```

### Capabilities Needed

- `market.pricefeed` — subscribe to real-time price data
- `market.execute` — place orders on an exchange
- `risk.check` — validate a proposed trade against risk limits
- `risk.position` — query current exposure
- `notify.alert` — human escalation for anomalous activity

### Data Flow

1. Price discovery agents subscribe to exchange feeds via `real-time-subscribe`
   and publish normalized prices to PubSub topic `market:{symbol}:price`.
2. Strategy agent subscribes to price PubSub, runs its model, and proposes
   a trade (buy 100 AAPL @ market).
3. **Before execution**, the proposed trade is sent to the risk management
   agent. The risk agent checks position limits, exposure, correlation
   with other open positions. It returns approve/reject/modify.
4. If approved, the strategy agent delegates execution to the execution
   agent via **UCAN**: `aafp://market/execute + symbol=AAPL + qty=100 +
   max_price=X + expires=60s`. The execution agent cannot exceed these
   bounds.
5. Execution result (fill price, quantity) is published to PubSub and
   recorded. Risk agent updates position state.
6. If the risk agent detects anomalous behavior (e.g., strategy agent
   proposing trades beyond limits repeatedly), it **revokes the UCAN
   delegation** and alerts a human.

### AAFP Features Used

- **PubSub** — real-time price distribution.
- **UCAN** — scoped execution authority with expiry and limits. This is
  critical: the execution agent physically cannot trade beyond the
  delegated bounds.
- **TrustManager** — exchange API keys.
- **Agent Reputation** — strategy agents with good track records get
  higher risk limits.
- **Adaptive Routing** — route to lowest-latency execution agent.
- **real-time-subscribe** — exchange webhook/feed ingestion.

### Why This Is a Killer App

Financial trading requires **separation of duties** (strategy vs.
execution vs. risk) and **enforced limits**. Today this is done with
internal microservices and ad-hoc auth. AAFP provides cryptographic
enforcement via UCAN — the execution agent cannot exceed its delegation.
This is a fundamentally more secure architecture for autonomous trading.

---

## Use Case 6: Content Moderation Network

### Concept

A layered content moderation network where detective agents detect
violations, reviewer agents confirm severity, and action agents enforce
decisions. Each layer can be run by different organizations for
transparency.

### Agent Topology

```
  Content Ingest
       │
       ▼
  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
  │ Detective   │  │ Detective   │  │ Detective   │
  │ Agent:      │  │ Agent:      │  │ Agent:      │
  │ Hate Speech │  │ NSFW        │  │ PII Leak    │
  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
         └────────┬───────┴─────────────────┘
                  ▼
          ┌───────────────┐
          │ Reviewer      │
          │ Agent         │
          │ (severity,    │
          │  context)     │
          └───────┬───────┘
                  ▼
          ┌───────────────┐
          │ Action Agent  │
          │ (remove,      │
          │  flag, shadow │
          │  ban, notify) │
          └───────────────┘
```

### Capabilities Needed

- `moderate.detect.{category}` — one per category (hate, nsfw, pii, spam,
  violence, etc.)
- `moderate.review` — contextual severity assessment
- `moderate.act` — enforce decision (delete, flag, escalate)
- `content.fetch` — retrieve the content to moderate
- `notify.user` — inform the content author

### Data Flow

1. Content ingest publishes new content to PubSub topic
   `moderate:queue`. Multiple detective agents subscribe, each
   specialized for a category.
2. Each detective agent runs its model and publishes a detection result
   (category, confidence, evidence refs) to
   `moderate:content:{id}:detections`.
3. The reviewer agent subscribes to detections for each content item.
   When detections arrive, it assesses context (is this satire? is the
   PII the user's own data?) and assigns a severity.
4. For high-severity items, the reviewer delegates to an action agent
   via UCAN: `aafp://moderate/act + content={id} + action=remove +
   reason=...`. The action agent executes and logs.
5. Borderline cases are escalated to human moderators via
   `notify.human` with a UCAN token for the human to approve/override.
6. All decisions are recorded in an **append-only log** (DHT-backed)
   for audit and appeal.

### AAFP Features Used

- **PubSub** — fan-out to multiple detective agents.
- **UCAN** — action authorization with audit trail.
- **DHT** — append-only moderation log for transparency/appeals.
- **Agent Reputation** — detective agents with high precision are
  weighted more heavily; the reviewer can cross-check.
- **Semantic discovery** — new moderation categories are added by
  deploying a new detective agent with a new capability; no config
  changes needed.
- **Agent-native content schema** — content represented structurally so
  detective agents can reference specific sections (`@s2` = paragraph 2).

### Why This Is a Killer App

Content moderation is currently a centralized black box. AAFP enables a
**transparent, multi-vendor moderation network** where different
organizations provide different detectors, decisions are auditable, and
appeals are cryptographically verifiable. This addresses the core
criticism of platform moderation: lack of transparency and accountability.

---

## Use Case 7: Personal AI Assistant Federation

### Concept

Your personal AI assistant doesn't try to do everything. It delegates to
specialist agents across the network — a travel agent, a finance agent,
a health agent, a coding agent — each with deep domain expertise.

### Agent Topology

```
          ┌──────────────────┐
          │  Personal        │
          │  Assistant       │
          │  (your agent,    │
          │   runs locally)  │
          └──┬───┬───┬───┬───┘
             │   │   │   │
    ┌────────▼┐ ┌▼───┐ ┌▼────────┐ ┌──────────┐
    │ Travel  │ │Fin │ │ Health  │ │ Coding   │
    │ Agent   │ │Age │ │ Agent   │ │ Agent    │
    └─────────┘ └────┘ └─────────┘ └──────────┘
```

### Capabilities Needed

- `assistant.personal` — local orchestration, intent classification
- `travel.plan` — itinerary planning, booking
- `finance.budget` — spending analysis, advice
- `health.track` — symptom checking, appointment scheduling
- `coding.help` — code generation, debugging
- `web-browse`, `search`, `api-call` — general internet interaction

### Data Flow

1. User tells their personal assistant: "Plan a trip to Tokyo, keep it
   under $3,000, and check if I need any vaccinations."
2. Personal assistant classifies intents: travel planning + health
   advisory. It discovers specialist agents via semantic capability
   queries.
3. For travel: delegates to a travel agent with a **UCAN token** scoped
   to `travel.plan + budget=$3000 + destination=Tokyo + expires=7d`. The
   travel agent uses `web-browse` and `api-call` to research flights and
   hotels. It cannot exceed the budget delegation.
4. For health: delegates to a health agent with a UCAN token scoped to
   `health.advisory + destination=Japan + scope=travel-vaccinations`.
   The health agent queries medical databases and returns advisories.
5. Both specialists stream results back. The personal assistant
   synthesizes: "Here's a 7-day Tokyo itinerary for $2,850. You should
   get a JE vaccine — here's where to schedule it."
6. The personal assistant maintains a **persistent context** (user
   preferences, past trips, budget history) locally. Specialist agents
   see only what's delegated to them — privacy by architecture.

### AAFP Features Used

- **UCAN delegation** — the core primitive. The personal assistant
  delegates scoped, time-limited authority to specialists. Specialists
  cannot exceed their delegation.
- **Semantic discovery** — "find a travel agent with booking capability
  and trust>95" is a graph query.
- **Agent Reputation** — specialists are selected by quality and
  reliability.
- **World Perception Layer** — specialists use web-browse, search,
  api-call to interact with the real world.
- **Stateful sessions** — the personal assistant maintains conversation
  state across multiple specialist interactions.
- **Privacy** — user data stays local; specialists receive only the
  scoped context needed for their task.

### Why This Is a Killer App

This is the **consumer-facing killer app**. Every user gets a personal
agent that's the front door to a federation of specialists. No single
company needs to build all capabilities. The personal assistant is the
user's **trusted intermediary** — it holds their preferences and
delegates with cryptographic limits. This is the AAFP vision of "every
new agent makes the network more capable" applied to personal computing.

---

## Use Case 8: IoT Edge Intelligence

### Concept

A hierarchy of agents from edge sensors through edge compute nodes to
cloud agents. Sensor agents collect data, edge agents do real-time
inference, and cloud agents do heavy analytics. The hierarchy adapts
based on connectivity and load.

### Agent Topology

```
  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐
  │Sensor│ │Sensor│ │Sensor│ │Sensor│
  │Agent │ │Agent │ │Agent │ │Agent │
  └──┬───┘ └──┬───┘ └──┬───┘ └──┬───┘
     └────┬───┴───────┬─┘          │
          ▼          ▼            │
     ┌──────────┐ ┌──────────┐    │
     │Edge Agent│ │Edge Agent│    │
     │(NPU/TPU, │ │(NPU/TPU, │    │
     │ realtime │ │ realtime │    │
     │ inference)│ │ inference)│   │
     └─────┬────┘ └─────┬────┘    │
           └──────┬─────┘         │
                  ▼               │
          ┌──────────────┐        │
          │ Cloud Agent  │◀───────┘
          │ (heavy ML,   │
          │  analytics,  │
          │  storage)    │
          └──────────────┘
```

### Capabilities Needed

- `sensor.read.{type}` — temperature, pressure, camera, accelerometer
- `edge.infer` — lightweight model inference on NPU/TPU
- `cloud.train` — model retraining on aggregated data
- `cloud.analyze` — long-term analytics, anomaly detection
- `edge.actuate` — control physical actuators (valves, motors)

### Data Flow

1. Sensor agents publish readings to local PubSub topics
   (`sensor:{id}:reading`). Edge agents subscribe.
2. Edge agents run real-time inference (e.g., anomaly detection on
   vibration data). If an anomaly is detected, the edge agent can
   **immediately actuate** (shut down a machine) without waiting for
   cloud confirmation — low-latency local control.
3. Edge agents periodically upload aggregated/anonymized data to cloud
   agents via chunked transfer. Cloud agents retrain models and push
   updated model weights back to edge agents via the DHT (content-
   addressed by model hash).
4. If connectivity to the cloud is lost, edge agents continue operating
   autonomously. When connectivity returns, they sync buffered data and
   pull updated models. **Stateful mobility** ensures no data loss.
5. Cloud agents provide dashboards and alerts to human operators.

### AAFP Features Used

- **PubSub** — local sensor data distribution.
- **Adaptive Routing Plane** — edge agents advertise NPU/TPU
  capabilities; routing accounts for edge resource constraints.
- **Stateful Mobility** — edge agents buffer and resume on
  reconnection.
- **DHT** — model distribution (content-addressed weights).
- **Chunked transfer + compression** — efficient data upload over
  constrained links.
- **UCAN** — actuation authority (edge agent can only control actuators
  it's delegated to).
- **Semantic Capability Graphs** — abstract hardware (NPU, TPU, ASIC)
  without encoding specific hardware assumptions.

### Why This Is a Killer App

IoT today is fragmented: each vendor has a proprietary cloud, and edge
intelligence is bolted on. AAFP provides a **unified agent hierarchy**
where edge and cloud agents collaborate with clear authority boundaries
(UCAN), resilient operation (stateful mobility), and hardware-agnostic
capability discovery. This aligns with the strategic principle: "Design
for hardware that doesn't exist yet."

---

## Use Case 9: Document Processing Pipeline

### Concept

A document processing pipeline that takes any document (PDF, image,
email, fax) and runs it through OCR → extraction → classification →
translation → summarization, with each stage handled by a specialized
agent.

### Agent Topology

```
  Document Ingest
       │
       ▼
  ┌──────────┐    ┌──────────────┐    ┌──────────────┐
  │ OCR      │───▶│ Extraction   │───▶│ Classify     │
  │ Agent    │    │ Agent        │    │ Agent        │
  │(Tesseract│    │(tables,      │    │(doc type,    │
  │ + Vision)│    │ entities)    │    │ priority)    │
  └──────────┘    └──────────────┘    └──────┬───────┘
                                             │
                              ┌──────────────▼──────────────┐
                              │                             │
                        ┌─────▼─────┐               ┌──────▼──────┐
                        │ Translate │               │ Summarize   │
                        │ Agent     │               │ Agent       │
                        └───────────┘               └─────────────┘
```

### Capabilities Needed

- `document-read` — parse PDF/Office docs (World Perception Layer)
- `image-ocr` — extract text from images/scans
- `extract.structured` — pull tables, entities, key-value pairs
- `classify.document` — categorize by type and priority
- `translate` — language translation (Use Case 4 mesh)
- `summarize` — abstractive summary generation

### Data Flow

1. A document arrives (via email webhook, file upload, or API). The
   ingest agent determines document type and routes to OCR or
   `document-read` accordingly.
2. OCR agent processes scanned pages, returns text + bounding boxes
   using the **agent-native content schema** (DocumentContent with
   ContentSection refs).
3. Extraction agent receives the structured content, pulls tables
   (TableDef), entities (Entity list), and key-value pairs. Results
   reference source locations via refs (`@t0` = table 0, `@s3` =
   section 3).
4. Classify agent determines document type (invoice, contract, letter)
   and priority. This determines downstream routing (e.g., invoices go
   to AP; contracts go to legal review).
5. Translate agent (from the translation mesh, Use Case 4) translates
   if the document is in a foreign language. Pivot routing handles
   rare languages automatically.
6. Summarize agent produces an executive summary. All outputs are
   assembled into a final structured document and stored.

### AAFP Features Used

- **Execution Fabric** — automatic pipeline assembly. The orchestrator
  declares the stages; the fabric sequences and parallelizes them.
- **Agent-native content schema (RFC-0016)** — structured content with
  refs enables precise cross-agent references.
- **DocumentContent schema** — tables, sections, media items
  represented uniformly.
- **Semantic discovery** — each stage discovers agents by capability
  (`image-ocr + english + latency<40ms`).
- **Streaming RPC** — large documents stream through stages.
- **DHT content cache** — repeated documents (same hash) skip
  reprocessing.
- **Stateful mobility** — long-running OCR jobs survive node failure.

### Why This Is a Killer App

Document processing is a universal enterprise need, currently served by
rigid RPA tools or expensive SaaS platforms. AAFP makes it a
**composable pipeline of best-of-breed agents**. New OCR engines,
extraction models, or summarizers join the network and are instantly
discoverable. The agent-native schema eliminates the "unstructured data"
problem that plagues current document processing.

---

## Use Case 10: Multi-Agent Game NPCs

### Concept

A game where NPCs are autonomous agents that negotiate, trade, form
alliances, and betray each other — creating emergent gameplay. Each NPC
is an AAFP agent with its own goals, memory, and strategy.

### Agent Topology

```
  ┌─────────────────────────────────────────────┐
  │              Game World Agent               │
  │  (physics, rules, state authority)          │
  └──────────────────┬──────────────────────────┘
                     │
    ┌────────┬───────┼───────┬────────┐
    ▼        ▼       ▼       ▼        ▼
  ┌───┐   ┌───┐   ┌───┐   ┌───┐   ┌───┐
  │NPC│   │NPC│   │NPC│   │NPC│   │NPC│
  │ 1 │   │ 2 │   │ 3 │   │ 4 │   │ 5 │
  └─┬─┘   └─┬─┘   └─┬─┘   └─┬─┘   └─┬─┘
    │       │       │       │       │
    └───┬───┴───┬───┘   ┌───┴───┬───┘
        │       │       │       │
   ┌────▼──┐ ┌──▼───┐ ┌─▼────┐ ┌▼──────┐
   │Trade  │ │Alli  │ │Diplo │ │Combat │
   │Negot. │ │ance  │ │macy  │ │Agent  │
   │Agent  │ │Agent │ │Agent │ │       │
   └───────┘ └──────┘ └──────┘ └───────┘
```

### Capabilities Needed

- `game.world-state` — query/subscribe to world state
- `game.act` — perform an action (move, attack, trade)
- `npc.negotiate` — bilateral or multilateral negotiation
- `npc.form-alliance` — establish a persistent alliance contract
- `npc.memory` — store and recall NPC memories

### Data Flow

1. The game world agent is the **state authority**. It publishes world
   state changes to PubSub (`game:world:state`). All NPCs subscribe.
2. Each NPC agent receives world state updates, runs its strategy model,
   and proposes actions. Actions are submitted to the world agent via
   `game.act` with a UCAN token (the NPC can only act within its
   capabilities — e.g., a merchant NPC can't attack).
3. NPCs negotiate with each other directly via bilateral RPC. A trade
   negotiation: NPC1 offers 50 wood for 30 gold. NPC2 evaluates and
   accepts/rejects/counters. Negotiation state is maintained via
   stateful sessions.
4. Alliances are formed via **multi-party UCAN delegation**: NPC1, NPC2,
   and NPC3 sign a shared alliance token that grants mutual defense
   obligations. The world agent recognizes the alliance and enforces
   its terms.
5. NPC memories are stored in the DHT (keyed by NPC ID + memory hash).
   This enables long-term relationship tracking ("NPC2 betrayed me last
   game, I won't trust them").
6. Human players interact via a player agent that has the same
   capabilities as NPC agents — humans and AI are peers in the world.

### AAFP Features Used

- **PubSub** — world state distribution.
- **UCAN** — action authorization and multi-party alliance contracts.
- **Stateful sessions** — negotiation state across multiple rounds.
- **DHT** — persistent NPC memory.
- **Agent Reputation** — NPCs build trust/reputation with each other
  based on past interactions (did they honor alliances?).
- **Peer-to-peer RPC** — NPCs negotiate directly without a central
  mediator.

### Why This Is a Killer App

Current game NPCs are scripted state machines. AAFP enables **truly
autonomous NPCs** with persistent memory, emergent social structures,
and genuine negotiation. The alliance contract mechanism (multi-party
UCAN) is unique — no game engine has cryptographic alliance enforcement.
This also demonstrates the "autonomous organizations" principle from
the strategic vision: NPCs form persistent social structures.

---

## Use Case 11: Decentralized Search

### Concept

A fully decentralized search engine where crawl agents discover and
fetch pages, index agents build inverted indices, and query agents
serve searches — all coordinated via AAFP's DHT and PubSub, with no
central server.

### Agent Topology

```
  Seed URLs
      │
      ▼
  ┌─────────────┐
  │ DHT URL     │
  │ Frontier    │
  └──────┬──────┘
         │ claim URL
    ┌────▼────┐  ┌────────┐  ┌────────┐
    │Crawler 1│  │Crawler2│  │Crawler3│  (N crawlers)
    │Agent    │  │Agent   │  │Agent   │
    └────┬────┘  └───┬────┘  └───┬────┘
         │           │           │
         └─────┬─────┴───────────┘
               ▼
     ┌──────────────────┐
     │ Content PubSub   │
     │ (fetched pages)  │
     └────────┬─────────┘
              ▼
     ┌──────────────┐  ┌──────────────┐
     │ Index Agent 1│  │ Index Agent 2│  (sharded by hash)
     │ (shard A)    │  │ (shard B)    │
     └──────┬───────┘  └──────┬───────┘
            │                 │
            └────────┬────────┘
                     ▼
            ┌────────────────┐
            │ Query Agent    │
            │ (fan-out to    │
            │  shards, merge)│
            └────────────────┘
```

### Capabilities Needed

- `crawl` — distributed web crawling (World Perception Layer)
- `index.build` — construct/update inverted index shard
- `index.query` — search a shard for a term
- `search.aggregate` — merge results from multiple shards
- `web-browse` — fetch pages (agent-native content)
- `robots.txt` awareness — politeness enforcement

### Data Flow

1. Crawl agents claim URLs from the DHT frontier (compare-and-swap to
   avoid duplicate crawling). Each agent checks robots.txt, enforces
   politeness delays, fetches the page via `web-browse`, extracts links,
   and adds new URLs back to the frontier.
2. Fetched pages (in agent-native content schema) are published to a
   PubSub topic (`search:content`). Index agents subscribe.
3. Index agents shard by content hash. Each index agent maintains an
   inverted index for its shard. New content updates the index
   incrementally.
4. When a query arrives, the query agent fans out to all index shards
   via parallel RPC. Each shard returns matching documents with
   relevance scores. The query agent merges and ranks.
5. Results are cached in the DHT content cache for common queries.
6. **Distributed rate limiting (RFC-0015)** ensures crawlers don't
   collectively DDoS any single domain.

### AAFP Features Used

- **DHT** — URL frontier, seen-set (deduplication), content cache.
- **PubSub** — content distribution from crawlers to indexers.
- **Distributed rate limiting (RFC-0015)** — per-domain quota across
  all crawlers.
- **robots.txt awareness** — per crawler, cached in DHT.
- **Agent-native content schema** — pages represented structurally,
  enabling better indexing (sections, entities, structured data).
- **Semantic discovery** — query agent discovers index shards by
  capability.
- **Parallel RPC** — query fan-out to shards.
- **Agent Reputation** — crawlers that respect politeness get higher
  trust; abusive crawlers are deprioritized.

### Why This Is a Killer App

Search is the most valuable application on the internet, and it's
controlled by 2-3 companies because the infrastructure cost is
enormous. AAFP enables **decentralized search** where anyone can
contribute crawl or index capacity. The DHT frontier + distributed rate
limiting solve the coordination problems that make decentralized crawl
hard. This is the "open graph" competing with "closed silos" vision
made literal.

---

## Use Case 12: AI-Powered CI/CD

### Concept

A CI/CD pipeline where test agents, deploy agents, and monitor agents
collaborate autonomously. Tests run on commit, deployment is gated by
test results and risk assessment, and post-deploy monitoring feeds back
into the test suite.

### Agent Topology

```
  Git Commit
      │
      ▼
  ┌──────────┐     ┌──────────────┐     ┌──────────────┐
  │ Test     │────▶│ Risk         │────▶│ Deploy       │
  │ Agent    │     │ Assessment   │     │ Agent        │
  │ (unit,   │     │ Agent        │     │ (canary,     │
  │  integ,  │     │ (change      │     │  blue-green) │
  │  e2e)    │     │  impact)     │     │              │
  └──────────┘     └──────────────┘     └──────┬───────┘
                                               │
                                               ▼
                                       ┌──────────────┐
                                       │ Monitor      │
                                       │ Agent        │
                                       │ (metrics,    │
                                       │  logs,       │
                                       │  auto-       │
                                       │  rollback)   │
                                       └──────────────┘
```

### Capabilities Needed

- `ci.test` — run test suites (unit, integration, e2e)
- `ci.risk-assess` — evaluate change risk (blast radius, affected
  services)
- `cd.deploy` — execute deployment strategy
- `cd.monitor` — observe post-deploy metrics
- `cd.rollback` — revert deployment on anomaly
- `notify.human` — escalate to on-call engineer
- `code-execute` — run tests in sandbox

### Data Flow

1. On commit, the test agent fetches the diff and runs relevant test
   suites (determined by change impact analysis). Results stream via
   server-streaming RPC.
2. The risk assessment agent evaluates the change: how many services are
   affected? Is this a breaking API change? What's the blast radius? It
   assigns a risk score.
3. If tests pass and risk is acceptable, the deploy agent executes the
   deployment strategy. For high-risk changes, it uses **canary
   deployment** with a UCAN token scoped to `cd.deploy + strategy=canary
   + max_instances=10% + duration=30m`.
4. The monitor agent watches post-deploy metrics (error rate, latency,
   throughput). It subscribes to metric feeds via `real-time-subscribe`.
5. If the monitor agent detects anomalies (error rate > threshold), it
   **automatically rolls back** by invoking `cd.rollback` — but only if
   it holds a UCAN token authorizing rollback (delegated by the deploy
   agent at deploy time).
6. For critical anomalies, the monitor agent escalates to a human
   on-call engineer via `notify.human` with a UCAN token for manual
   intervention.

### AAFP Features Used

- **UCAN** — deployment and rollback authority with scope and expiry.
  The monitor agent can only roll back what it was delegated to.
- **Streaming RPC** — test results stream in real time.
- **PubSub** — metric feeds for monitoring.
- **real-time-subscribe** — metric/log ingestion.
- **Execution Fabric** — pipeline assembly (test → assess → deploy →
  monitor).
- **Agent Reputation** — deploy agents with successful track records
  are trusted with higher-risk deployments.
- **Stateful mobility** — long-running e2e tests survive runner
  failure.
- **code-execute** — test execution in sandboxed environment.

### Why This Is a Killer App

CI/CD today requires extensive YAML/Groovy pipeline configuration and
manual risk judgment. AAFP makes it **declarative and autonomous**: the
network assembles the pipeline, assesses risk, and enforces rollback
authority cryptographically. The UCAN-scoped rollback is a security
primitive no existing CI/CD system has — the monitor can roll back
*only what it was explicitly authorized to*.

---

## Use Case 13: Healthcare Data Federation

### Concept

A privacy-preserving federation where healthcare agents from different
institutions collaborate on patient care and research without exposing
raw patient data. Agents compute on data in place and share only
aggregated, anonymized results.

### Agent Topology

```
  ┌──────────┐  ┌──────────┐  ┌──────────┐
  │ Hospital │  │ Hospital │  │ Research │
  │ A Agent  │  │ B Agent  │  │ Lab Agent│
  │ (data    │  │ (data    │  │ (studies,│
  │  stays   │  │  stays   │  │  trials) │
  │  local)  │  │  local)  │  │          │
  └────┬─────┘  └────┬─────┘  └────┬─────┘
       │             │             │
       └──────┬──────┴──────┬──────┘
              ▼             ▼
       ┌────────────┐ ┌──────────────┐
       │ Care       │ │ Research     │
       │ Coord.     │ │ Aggregation  │
       │ Agent      │ │ Agent        │
       │ (treatment │ │ (federated   │
       │  plans)    │ │  learning)   │
       └────────────┘ └──────────────┘
```

### Capabilities Needed

- `health.query-patient` — query patient data (with patient UCAN
  consent)
- `health.compute-local` — run computation on local data, return
  aggregated result
- `health.federated-train` — federated learning across institutions
- `health.care-plan` — synthesize treatment recommendations
- `health.consent` — manage patient consent tokens

### Data Flow

1. A patient authorizes data sharing by issuing a **UCAN consent token**
   to a care coordination agent: `aafp://health/query-patient +
   patient={id} + scope={fields} + expires=90d + recipients={hospitalA,
   hospitalB}`.
2. The care coordination agent presents the UCAN token to each
   hospital agent. Each hospital agent **verifies the token** and
   returns only the authorized fields — raw data never leaves the
   institution.
3. For treatment planning, the care coordination agent asks each
   hospital agent to run specific computations locally (e.g.,
   "calculate average blood pressure over 30 days") and return only
   the aggregate. This is **compute-to-data**, not data-to-compute.
4. For research, the research aggregation agent coordinates federated
   learning: each hospital agent trains a local model on its data and
   shares only **model gradients** (not raw data) via the Execution
   Fabric. The aggregation agent combines gradients into a global model.
5. All access is logged in an **append-only audit log** (DHT-backed).
   Patients can review who accessed their data and when.
6. Consent can be **revoked** at any time; the UCAN token is
   invalidated and future access is denied.

### AAFP Features Used

- **UCAN** — the core privacy primitive. Patient consent is a
  cryptographically signed, scoped, time-limited token. Institutions
  can only access what the patient authorized.
- **DHT** — append-only audit log for compliance (HIPAA, GDPR).
- **Execution Fabric** — federated learning pipeline (local training →
  gradient aggregation → global model).
- **Agent Reputation** — institutions with strong privacy practices
  earn higher trust.
- **TrustManager** — patient consent token storage and verification.
- **Semantic discovery** — "find a hospital agent with cardiology
  capability in region X."
- **Compression** — gradient transfer is compressed.

### Why This Is a Killer App

Healthcare data sharing is blocked by privacy regulations and
institutional silos. AAFP's UCAN-based consent + compute-to-data
pattern enables **collaboration without data exposure**. This is
impossible with HTTP alone — there's no cryptographic consent
delegation, no compute-to-data routing, no audit trail. This use case
alone could transform medical research and patient care.

---

## Use Case 14: Supply Chain Optimization

### Concept

A supply chain network where supplier agents, logistics agents, and
buyer agents negotiate contracts, optimize routes, and respond to
disruptions in real time — without a central ERP system.

### Agent Topology

```
  ┌────────┐  ┌────────┐  ┌────────┐
  │Supplier│  │Supplier│  │Supplier│
  │Agent A │  │Agent B │  │Agent C │
  └───┬────┘  └───┬────┘  └───┬────┘
      │           │           │
      └─────┬─────┴─────┬─────┘
            ▼           ▼
     ┌────────────┐ ┌────────────┐
     │ Logistics  │ │ Logistics  │
     │ Agent X    │ │ Agent Y    │
     │ (shipping, │ │ (trucking, │
     │  freight)  │ │  last-mile)│
     └─────┬──────┘ └──────┬─────┘
            └──────┬───────┘
                   ▼
            ┌────────────┐
            │ Buyer      │
            │ Agent      │
            │ (procurement│
            │  planning) │
            └────────────┘
```

### Capabilities Needed

- `supply.quote` — provide pricing and availability
- `supply.contract` — negotiate and sign a supply contract
- `logistics.route` — plan and optimize shipping routes
- `logistics.track` — real-time shipment tracking
- `supply.disrupt` — report and respond to disruptions
- `buyer.demand-forecast` — predict future demand

### Data Flow

1. The buyer agent publishes a demand forecast to PubSub
   (`supply:demand:{product}`). Supplier agents subscribe and
   proactively prepare quotes.
2. The buyer agent requests quotes from multiple supplier agents via
   parallel RPC. Each supplier responds with price, quantity, lead
   time, and terms.
3. The buyer agent evaluates quotes and negotiates with the preferred
   supplier via stateful negotiation sessions. The final contract is
   a **multi-party UCAN token** signed by both buyer and supplier,
   encoding quantity, price, delivery date, and penalties.
4. The buyer agent delegates logistics to a logistics agent via UCAN:
   `aafp://logistics/route + origin={A} + destination={B} +
   constraints={temperature, deadline}`. The logistics agent plans
   the optimal route and books carriers.
5. During transit, the logistics agent publishes tracking updates to
   PubSub (`logistics:shipment:{id}:track`). The buyer agent monitors.
6. If a disruption occurs (port closure, weather event), the logistics
   agent publishes to `supply:disrupt`. Affected supplier and buyer
   agents automatically renegotiate and reroute — the network
   self-heals.
7. All transactions are recorded in the DHT for audit and dispute
   resolution.

### AAFP Features Used

- **PubSub** — demand forecasts and disruption alerts.
- **UCAN** — multi-party contracts with encoded terms and penalties.
- **Stateful sessions** — multi-round negotiation.
- **DHT** — transaction audit log.
- **Agent Reputation** — suppliers with on-time delivery records earn
  higher trust and win more contracts.
- **Adaptive Routing** — logistics route optimization across multiple
  carriers.
- **Semantic discovery** — "find a supplier of component X in region Y
  with ISO9001 certification."
- **Economic Layer** — contract pricing, penalty calculation, payment
  authorization.

### Why This Is a Killer App

Supply chains today rely on centralized ERPs and manual coordination.
Disruptions (COVID, Suez Canal, weather) cause cascading failures
because there's no real-time multi-party negotiation. AAFP enables a
**self-healing supply chain network** where agents renegotiate and
reroute automatically. The UCAN-based contract is a cryptographic
improvement over paper/PDF contracts — terms are machine-enforceable.

---

## Use Case 15: Creative Collaboration

### Concept

A creative pipeline where a writer agent, editor agent, and illustrator
agent collaborate on producing content — articles, stories, marketing
copy — with iterative refinement and human-in-the-loop approval.

### Agent Topology

```
  ┌──────────┐
  │ Human    │
  │ Director │
  │ (brief)  │
  └────┬─────┘
       ▼
  ┌──────────┐    ┌──────────────┐    ┌──────────────┐
  │ Writer   │───▶│ Editor       │───▶│ Illustrator  │
  │ Agent    │    │ Agent        │    │ Agent        │
  │ (drafts) │    │ (revises,    │    │ (visualizes  │
  │          │    │  fact-checks)│    │  scenes)     │
  └──────────┘    └──────────────┘    └──────┬───────┘
                                            │
                                            ▼
                                    ┌──────────────┐
                                    │ Layout       │
                                    │ Agent        │
                                    │ (final       │
                                    │  composition)│
                                    └──────────────┘
```

### Capabilities Needed

- `creative.write` — draft text content
- `creative.edit` — revise, fact-check, improve prose
- `creative.illustrate` — generate images for text
- `creative.layout` — compose final document (text + images)
- `web-browse`, `search` — research for fact-checking
- `notify.human` — human review gates

### Data Flow

1. The human director provides a brief (topic, tone, length, audience).
   This is issued as a UCAN token to the writer agent:
   `aafp://creative/write + topic={X} + tone={Y} + max_words={N}`.
2. The writer agent drafts the content, using `search` and `web-browse`
   for research. The draft is published to PubSub
   (`creative:project:{id}:draft`).
3. The editor agent subscribes, reviews the draft for factual accuracy
   (cross-checking via `search`), prose quality, and tone alignment. It
   returns revisions with **refs to specific sections** (`@s2 needs a
   citation`, `@s4 tone is too formal`).
4. The writer agent incorporates revisions and publishes the revised
   draft. This iterate-review cycle continues until the editor approves.
5. The approved text is sent to the illustrator agent, which generates
   images for key scenes/sections. Image descriptions reference text
   sections via refs.
6. The layout agent composes the final document (text + images) in the
   agent-native content schema and delivers it.
7. At defined gates (after draft, after illustration), the pipeline
   notifies the human director for approval via `notify.human` with a
   UCAN token for approve/request-changes.

### AAFP Features Used

- **UCAN** — scoped creative authority (the writer can't exceed the
  brief's constraints; the illustrator can only illustrate the approved
  text).
- **PubSub** — draft distribution to editor and illustrator.
- **Agent-native content schema** — content represented with section
  refs enabling precise editorial feedback.
- **Stateful sessions** — iterative review cycles maintain state.
- **World Perception Layer** — `search` and `web-browse` for research
  and fact-checking.
- **Execution Fabric** — pipeline assembly (write → edit → illustrate →
  layout).
- **Agent Reputation** — writer and editor agents with high-quality
  output are preferred for future projects.

### Why This Is a Killer App

Creative work today is either fully automated (low quality) or fully
manual (slow). AAFP enables a **hybrid creative pipeline** where agents
handle drafting and iteration, humans provide direction and approval,
and the pipeline is composable — swap in a different writer agent or
illustrator agent without reconfiguring anything. The section-ref
system enables precise, structured editorial feedback that current
LLM-based tools lack.

---

## Cross-Cutting Analysis

### Recurring AAFP Features

Across all 15 use cases, certain features are load-bearing:

| Feature | Use Cases | Frequency |
|---------|-----------|-----------|
| UCAN delegation | 1,2,3,5,6,7,8,10,12,13,14,15 | 12/15 |
| Semantic discovery | 1,2,4,7,8,9,11,13,14 | 9/15 |
| PubSub | 2,3,5,6,8,10,11,14,15 | 9/15 |
| Agent Reputation | 1,2,4,5,6,7,11,12,13,14,15 | 11/15 |
| Execution Fabric | 1,3,4,9,12,13,15 | 7/15 |
| DHT | 1,6,10,11,13,14 | 6/15 |
| Streaming RPC | 3,4,9,12 | 4/15 |
| Stateful mobility | 1,8,9,12 | 4/15 |
| World Perception Layer | 2,3,7,9,11,15 | 6/15 |
| Agent-native content schema | 3,6,9,15 | 4/15 |
| Stateful sessions | 7,10,14,15 | 4/15 |
| Economic Layer | 1,5,14 | 3/15 |

### Key Insights

1. **UCAN is the most critical feature.** 12 of 15 use cases depend on
   scoped, cryptographically-enforced delegation. This is AAFP's
   primary differentiator — no other protocol provides this for agent
   interactions.

2. **Agent Reputation is nearly universal.** 11 of 15 use cases benefit
   from performance-weighted agent selection. This is the "network
   becomes more intelligent as agents join" principle in action.

3. **Semantic discovery enables composability.** 9 of 15 use cases
   require discovering agents by capability graph, not string lookup.
   Without this, every use case degrades to hardcoded endpoints.

4. **PubSub is the coordination backbone.** 9 of 15 use cases use
   PubSub for real-time event distribution. It's the difference between
   a request-response intranet and a living network.

5. **The Execution Fabric enables declarative pipelines.** 7 of 15 use
   cases are pipelines that the fabric assembles automatically. This is
   the "protocol should reduce developer decisions" principle.

6. **The World Perception Layer is the bridge to reality.** 6 of 15 use
   cases require agents to interact with the real world (web, APIs,
   documents). Without it, AAFP is an intranet.

### Use Case Categories

| Category | Use Cases | Primary Value |
|----------|-----------|---------------|
| Federated compute | 1, 4, 13 | Resource sharing without central control |
| Multi-vendor collaboration | 2, 14 | Agents as the integration layer |
| Autonomous pipelines | 3, 9, 12, 15 | Declarative pipeline assembly |
| Autonomous systems | 5, 8, 10 | Self-governing agent networks |
| Trust-sensitive systems | 5, 6, 13 | Cryptographic authority + audit |
| Consumer applications | 7, 10 | Personal agents + entertainment |
| Infrastructure | 11, 12 | Decentralized alternatives to centralized services |
| Edge/intelligence hierarchy | 8 | Edge-cloud collaboration |

---

## Killer App Prioritization

Based on the analysis, the highest-impact killer apps for driving AAFP
adoption are:

### Tier 1: Immediate Ecosystem Builders (Phase 3-4)

1. **Personal AI Assistant Federation (Use Case 7)** — Consumer-facing,
   demonstrates UCAN delegation, semantic discovery, and the World
   Perception Layer. This is the "3-line API" demo that makes developers
   say "I want this."

2. **Code Review Pipeline (Use Case 3)** — Developer-facing, low trust
   barrier (internal use), demonstrates streaming RPC, execution fabric,
   and agent-native content schema. Developers are the first adopters.

3. **Document Processing Pipeline (Use Case 9)** — Enterprise-facing,
   universal need, demonstrates the full World Perception Layer and
   pipeline composition. Clear ROI.

### Tier 2: Network Effect Drivers (Phase 4-5)

4. **Customer Support Mesh (Use Case 2)** — B2B, demonstrates
   multi-vendor agent collaboration. Each new vendor that joins
   increases value.

5. **Decentralized Search (Use Case 11)** — Infrastructure, demonstrates
   DHT + PubSub + distributed rate limiting at scale. Competes directly
   with centralized search.

6. **Real-Time Translation Mesh (Use Case 4)** — Global, demonstrates
   semantic capability routing and automatic pipeline composition.
   Every new language agent increases coverage.

### Tier 3: Differentiation Demonstrators (Phase 5-6)

7. **Healthcare Data Federation (Use Case 13)** — High-impact, uniquely
   requires UCAN consent + compute-to-data. No competitor can replicate
   without AAFP's trust model.

8. **Autonomous Trading Agents (Use Case 5)** — Financial, demonstrates
   UCAN-enforced risk limits. High stakes, clear security value.

9. **Distributed AI Research Lab (Use Case 1)** — Research, demonstrates
   stateful mobility and economic layer. Attracts the AI research
   community.

### Tier 4: Long-Tail Expansion (Phase 6-7)

10. **Content Moderation Network (Use Case 6)**
11. **IoT Edge Intelligence (Use Case 8)**
12. **Multi-Agent Game NPCs (Use Case 10)**
13. **AI-Powered CI/CD (Use Case 12)**
14. **Supply Chain Optimization (Use Case 14)**
15. **Creative Collaboration (Use Case 15)**

---

## Conclusion

These 15 use cases demonstrate that AAFP's value is not in any single
feature but in the **composition** of features: UCAN for authority,
semantic discovery for composability, PubSub for coordination,
reputation for quality, the Execution Fabric for automation, and the
World Perception Layer for real-world interaction.

The killer apps are those where this composition enables something
**impossible with today's infrastructure** — not merely better, but
categorically different. The personal assistant federation, healthcare
data federation, and decentralized search are the clearest examples:
each requires trust, discovery, coordination, and real-world interaction
working together, which no existing protocol provides.

The path to adoption is: build the Tier 1 use cases as reference
applications, use them to attract developers, and let the network
effect drive Tier 2 and beyond. As the strategic vision states: "Build
the ecosystem before the protocol is finished."

---

**Next action:** Select 2-3 Tier 1 use cases for reference implementation
in Phase 3, with the personal assistant federation as the flagship demo.
