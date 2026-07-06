# AAFP Multi-Agent Orchestration Patterns

**Status:** Design Document (research)
**Track:** V — Execution Fabric / Orchestration
**Date:** 2026-07-05
**Depends on:** `SEMANTIC_CAPABILITY_GRAPHS.md` (Track U), `STRATEGIC_VISION.md`

---

## Purpose

The Strategic Vision states that AAFP should "deliver execution, not bytes" and
that the Execution Fabric should "automatically assemble pipelines" with "no
human wiring, no hardcoded endpoints." The Semantic Capability Graphs document
defines the data model (`SemanticCapability`, `CapabilityEdge`, `PipelineAssembler`)
that makes discovery-as-planning possible. This document fills the gap between
those two: **what shapes can assembled execution take?**

An orchestration pattern is a recurring topology of agent interactions — who
calls whom, in what order, with what failure semantics. Each pattern maps onto
AAFP primitives (discovery, capability edges, routing metrics, trust scoring,
checkpointing) and imposes requirements on the protocol. The patterns are not
mutually exclusive: a real workflow may nest a fan-out inside a pipeline inside
a hierarchy inside a market. The goal is to name the building blocks so that
the Execution Fabric scheduler, the `PipelineAssembler`, and SDK authors share
a common vocabulary.

Twelve patterns are documented below. For each: when to use it, the AAFP
features it depends on, a topology diagram, and the failure modes that the
protocol must handle. A summary comparison table and a set of cross-cutting
concerns close the document.

---

## Conventions

- **A, B, C, D** denote agents (or capability providers). The same letter may
  refer to a role rather than a specific agent — e.g., "A" in the Router
  pattern is the router role.
- Arrows `→` denote a synchronous or asynchronous capability invocation.
- Arrows `↔` denote a multi-turn conversation.
- Dashed arrows `⇢` denote an event/notification (fire-and-forget).
- Boxes `[ ]` denote agents; diamonds `< >` denote decisions; bars `═══`
  denote synchronization points.
- "AAFP features needed" lists the protocol/SDK facilities the pattern relies
  on, with a pointer to the design doc that defines them where applicable.

---

## Pattern 1 — Pipeline (Linear)

### When to use

Use the pipeline when work decomposes into a fixed, ordered sequence of
transforms and each stage's output is the next stage's input. This is the
default shape for document processing, media transcoding, data ETL, and the
"Vision → OCR → Translator → Reasoner → Writer" example in the Strategic
Vision. It is the simplest pattern and the one the `PipelineAssembler`
(Section 6 of `SEMANTIC_CAPABILITY_GRAPHS.md`) produces directly from
`Precedes` edges in the capability graph.

### AAFP features needed

- **Semantic capability graph** with `EdgeType::Precedes` to express ordering
  (`SEMANTIC_CAPABILITY_GRAPHS.md` §3.1).
- **`PipelineAssembler`** graph traversal to turn a goal query into an ordered
  `Vec<PipelineStep>` (`SEMANTIC_CAPABILITY_GRAPHS.md` §6).
- **Streaming RPC** so stage N can stream partial output to stage N+1 without
  buffering the whole document (`STREAMING_RPC_DESIGN.md`).
- **Checkpointing** (Execution Fabric, Phase 4) so a failed stage can resume
  from the last barrier rather than restarting the head.
- **Capability query** with `PerformanceFilter` to pick low-latency stages for
  latency-bound pipelines, or `CostFilter` for batch pipelines.

### Topology

```
        ┌───┐    ┌───┐    ┌───┐    ┌───┐
 goal → │ A │───→│ B │───→│ C │───→│ D │ → result
        └───┘    └───┘    └───┘    └───┘
        OCR    parse   translate   write
```

Concrete example from the Strategic Vision:

```
Need: Image understanding
  → Vision Agent → OCR Agent → Translator → Reasoner → Writer
```

### Failure modes

- **Stage N fails.** Without checkpointing, the entire pipeline must restart
  from A. Mitigation: per-stage barriers with idempotent re-invocation; the
  scheduler re-discovers a replacement for the failed capability (using the
  `Alternative` edge) and resumes from the last checkpoint.
- **Slow stage stalls the tail.** A single slow agent (high `p99_latency_ms`)
  makes the whole pipeline latency-bound. Mitigation: the Adaptive Routing
  Plane (Track T) exposes live `RoutingMetrics`; the scheduler picks a faster
  alternative or replicates the slow stage.
- **Output schema mismatch.** Stage N produces a format stage N+1 cannot
  consume. Mitigation: `OutputSpec` and `Requirement` in `SemanticCapability`
  are matched by the assembler before execution; mismatch is a planning error,
  not a runtime error.
- **Stage disappears mid-stream.** The agent churns between stages. Mitigation:
  discovery re-resolves the capability; if the new agent has a different
  `SemanticVersion` with a major bump, the assembler re-validates the edge.
- **Head-of-line blocking.** A monolithic first stage serializes all work.
  Mitigation: combine with Map-Reduce (Pattern 6) to parallelize the head.

---

## Pattern 2 — Fan-out / Fan-in

### When to use

Use fan-out/fan-in when a request can be decomposed into independent
sub-tasks that are aggregated into a single result. Examples: multi-source
research (query 5 search agents, merge), multi-model inference (run 3 models,
vote), multi-language translation (translate into 4 languages in parallel),
ensemble OCR (run 2 OCR engines, reconcile). The pattern trades cost for
latency and/or accuracy.

### AAFP features needed

- **Concurrent capability invocation** — the SDK must issue N parallel RPCs
  and await all (`futures::join_all` equivalent). This is an SDK concern, not
  a protocol concern, but the protocol must not serialize multiplexed streams.
- **QUIC multiplexing** — each fan-out call is a separate QUIC stream so
  head-of-line blocking across sub-tasks is avoided.
- **Aggregation capability** — the fan-in step is itself a capability
  ("merge", "vote", "reconcile") that must be discoverable, or it is performed
  by the originating agent A.
- **`CapabilityQuery` with `QualityFilter`** to select diverse sub-tasks
  (e.g., different models for an ensemble) rather than N identical agents.
- **Timeout / partial-result semantics** — the protocol must let A proceed
  with M-of-N results if some sub-tasks time out (see Failure modes).

### Topology

```
                 ┌───┐
            ┌───→│ B │───┐
            │    └───┘   │
        ┌───┤            │     ┌───┐
 goal → │ A │├───→┌───┐  ├────→│ A │ → result
        └───┤│    │ C │───┘    └───┘
            │├───→└───┘       aggregate
            │    ┌───┐
            └───→│ D │───┘
                 └───┘
              fan-out    fan-in
```

### Failure modes

- **One sub-task fails.** The aggregator must decide: fail the whole request,
  proceed with partial results, or re-issue to an alternative. The protocol
  should expose the failure reason so A can choose. A `QualityFilter` on the
  re-issue can demand a higher `trust_score` for the replacement.
- **Straggler.** One of N is slow; the rest wait at the fan-in bar. Mitigation:
  speculative execution — issue a duplicate to an `Alternative` capability and
  take the first to finish (costs extra, saves latency).
- **Aggregator is the bottleneck.** If A does the aggregation itself, A's
  single process can be overwhelmed. Mitigation: discover a dedicated
  "merge"/"vote" capability and let it run on a separate agent.
- **Cost explosion.** N parallel calls cost N×. Mitigation: `CostFilter` with
  `max_per_invocation_micro_usd`; the economic layer (Phase 7) can enforce
  budgets.
- **Inconsistent sub-task semantics.** B, C, D interpret the sub-task
  differently. Mitigation: the `CapabilityQuery` should pin `version` and
  `SemanticMatch` so all sub-tasks use compatible semantics.

---

## Pattern 3 — Router

### When to use

Use the router when a single entry agent inspects the request and dispatches
it to exactly one of several specialized handlers based on content, metadata,
or heuristics. Examples: a front-door agent that routes "is this a code
question? → code agent", "is this a vision task? → vision agent"; a language
detector that routes to the right translator; a triage agent that routes
support tickets by topic. Unlike the Broker (Pattern 4), the router decides
alone — there is no negotiation.

### AAFP features needed

- **Inspection capability** at A — typically a fast classifier (LLM call or
  heuristic). This is itself a discoverable capability ("classify", "route").
- **`CapabilityQuery` with `SemanticMatch`** so the router can express "route
  to a handler whose `category` semantically matches the detected intent."
- **`EdgeType::Alternative`** in the capability graph to enumerate the
  candidate handlers B, C, D for a given intent space.
- **Low-latency discovery** — routing adds a hop; the router's own capability
  must have low `avg_latency_ms` or it dominates.
- **Routing metrics** (Track T) so the router can avoid a handler that is
  currently overloaded even if it is the "right" category.

### Topology

```
                 ┌─────┐
            ┌───→│  B  │ code
            │    └─────┘
        ┌───┤<classify?>
 goal → │ A │├───→┌─────┐
        └───┤│    │  C  │ vision
            │├───→└─────┘
            │    ┌─────┐
            └───→│  D  │ text
                 └─────┘
```

### Failure modes

- **Misclassification.** A routes to the wrong handler. Mitigation: confidence
  thresholds; if A's classify confidence is low, fall back to the Broker
  (Pattern 4) or Chain-of-Responsibility (Pattern 5). The protocol should let
  A attach the classification rationale so downstream agents can detect
  mismatch.
- **Router is a single point of failure.** If A dies, no requests are routed.
  Mitigation: A is itself a discoverable capability; clients re-discover a
  replacement router. Replication of the router role (multiple agents
  advertising "route") is the long-term answer.
- **Handler unavailable.** The chosen handler B has churned. Mitigation: the
  router re-queries with `EdgeType::Alternative` to find a sibling handler.
- **Routing overhead dominates.** For very fast sub-tasks, the classification
  hop costs more than the work. Mitigation: cache classifications by request
  signature; bypass the router for known request shapes.
- **Cold-start bias.** A new handler D has no `success_count` so the router
  never picks it. Mitigation: exploration in routing (epsilon-greedy) so new
  agents get traffic and build reputation (Track W).

---

## Pattern 4 — Broker

### When to use

Use the broker when a request must be matched to a provider based on
multi-dimensional criteria that no single party knows fully — the requester
knows its needs, the providers know their capabilities and current load, and
the broker negotiates a match. Examples: "find me the cheapest OCR under 40ms
with trust >95% in North America" where providers bid on price/latency; a
data-broker that matches a buyer's dataset need to sellers; a model broker
that picks between proprietary and open models based on budget and SLA.
Unlike the Router, the broker solicits bids and selects; it is a matchmaker,
not a classifier.

### AAFP features needed

- **Semantic capability graph** — the broker's core job is multi-dimensional
  matching, which is exactly what `CapabilityQuery` + `SemanticCapability`
  express (`SEMANTIC_CAPABILITY_GRAPHS.md` §4).
- **`EdgeType::Alternative`** to enumerate candidates for the same need.
- **Adaptive Routing Plane metrics** (Track T) so the broker can factor live
  load into the match, not just static capability descriptions.
- **Reputation** (Track W) so the broker can prefer providers with high
  `success_count` and `trust_score`.
- **Economic layer** (Phase 7) for price discovery — providers must be able to
  quote a cost and the broker must be able to compare. Without an economic
  layer, the broker degrades to the Router.
- **Bid/quote RPC** — a protocol message where providers respond to a match
  request with a quote (price, latency, confidence) rather than executing
  immediately. This is a new RPC kind the Execution Fabric must support.

### Topology

```
                 ┌─────┐
            ┌───→│  B  │ quote: 30ms/$0.0001
            │    └─────┘
        ┌───┤<bid?>
 goal → │ A │├───→┌─────┐
        └───┤│    │  C  │ quote: 20ms/$0.0003
            │├───→└─────┘
            │    ┌─────┐
            └───→│  D  │ quote: 45ms/$0.00005
                 └─────┘
              A selects best bid → dispatch
```

### Failure modes

- **No provider bids.** The need is too niche or all providers are overloaded.
  Mitigation: the broker relaxes constraints (raise latency budget, lower trust
  threshold) and re-queries; if still nothing, it returns "no match" to the
  client.
- **Bid is not honored.** A provider quotes 20ms but actually takes 200ms.
  Mitigation: reputation (Track W) records the discrepancy; future bids from
  that provider are discounted. The protocol should record quoted-vs-actual
  metrics.
- **Broker is a trust bottleneck.** All matches flow through A; a malicious A
  could steer work to cronies. Mitigation: clients can verify the bid set
  themselves by issuing the same `CapabilityQuery` directly; the broker is an
  optimization, not a sole source of truth.
- **Slow bidding.** Collecting bids adds latency. Mitigation: bounded bid
  window (e.g., first 5 bids or 10ms, whichever first); the broker proceeds
  with what it has.
- **Collusion.** Providers coordinate to keep prices high. Mitigation: the
  broker can also solicit from the open DHT, not just known providers, so new
  entrants undercut cartels. This is where the open-graph moat (Strategic
  Vision §10) matters.

---

## Pattern 5 — Chain of Responsibility

### When to use

Use the chain when a request should be handled by the first agent that can
succeed, falling through to the next on failure or "I can't handle this."
Examples: a support escalation chain (L1 → L2 → L3), a fallback model chain
(cheap model → if low confidence → expensive model), a multi-format parser
(JSON parser → if invalid → YAML parser → if invalid → XML parser). Unlike
the Router, the decision is made by each handler trying and yielding, not by
a central classifier.

### AAFP features needed

- **`EdgeType::Alternative`** to express the ordered fallback list in the
  capability graph. The chain order can be encoded by `Precedes` edges among
  alternatives or by a priority field.
- **Explicit "cannot handle" return** — a protocol-level status that means
  "try the next agent," distinct from "I failed." Without this, the chain
  cannot distinguish a hard failure from a soft decline.
- **Idempotent handlers** so that partial work done by a declining agent does
  not corrupt the next attempt.
- **Cost-aware ordering** — the assembler should order the chain cheapest-first
  (or fastest-first) so the expensive agent is only invoked when cheap ones
  decline.
- **Reputation** so that an agent that frequently declines is deprioritized.

### Topology

```
        ┌───┐ try   ┌───┐ try   ┌───┐ try   ┌───┐
 goal → │ A │─────→│ B │─────→│ C │─────→│ D │ → result
        └───┘ decl  └───┘ decl  └───┘ decl  └───┘
         L1          L2          L3         L4
         │           │           │
         └─"can't"   └─"can't"   └─"can't"
```

### Failure modes

- **All handlers decline.** The request is unhandled. Mitigation: a terminal
  "give up" handler that logs or returns a graceful failure to the client.
- **Handler partially succeeds then fails.** It mutated state but could not
  finish. Mitigation: idempotency keys on requests; the next handler treats
  partial state as "not started" or resumes it. Checkpointing helps.
- **Wrong chain order.** An expensive handler is placed before a cheap one
  that would have sufficed. Mitigation: the assembler orders by `CostModel`
  and `PerformanceProfile`; chain authors should not hand-order.
- **Cascading latency.** Each decline adds a hop; with N handlers and worst
  case, latency is the sum of all decline times. Mitigation: parallel
  speculation — issue to the first two handlers simultaneously and cancel the
  loser (costs extra, bounds latency).
- **Silent failure mistaken for decline.** A handler crashes rather than
  returning "can't handle." Mitigation: the protocol distinguishes a crash
  (no response / transport error) from an explicit decline; a crash should
  not advance the chain but trigger retry or escalation.

---

## Pattern 6 — Map-Reduce

### When to use

Use map-reduce when work is embarrassingly parallel over a large input that
can be split into chunks, and the results must be combined. Examples:
summarizing 1000 documents (map: summarize each, reduce: synthesize),
indexing a crawl (map: parse each page, reduce: build index), large-batch
inference (map: run model on each batch, reduce: concatenate). Unlike
fan-out/fan-in, map-reduce explicitly splits the input and the reduce step is
a real aggregation function, not just "collect N results."

### AAFP features needed

- **Splitter capability** at A — a discoverable capability ("split",
  "chunk") that divides the input. Or A does it inline.
- **`max_batch_size`** in `PerformanceProfile` so the splitter knows how
  coarse to make chunks for each worker.
- **Worker capability** with `throughput_rps` advertised so the scheduler can
  size the worker pool to the input volume.
- **Reducer capability** — discoverable ("reduce", "merge", "synthesize").
  The reducer is often the hardest part to find via discovery; it should be
  expressed as a capability with `Requirement` on the map output schema.
- **Checkpointing** so a failed map worker's chunk is re-issued, not the whole
  job.
- **Work queue / lease semantics** — the Execution Fabric must hand out chunks
  to workers with leases so that a dead worker's chunk is re-issued after a
  timeout. This is a scheduler concern (Phase 4).

### Topology

```
        ┌───┐ split   ┌───┐ chunk₁
        │ A │────────→│ B │──┐
        └───┘         └───┘  │
         │            ┌───┐  │
         ├───────────→│ C │──┤
         │            └───┘  │     ┌───┐
         │            ┌───┐  ├────→│ A │ → result
         ├───────────→│ D │──┘     └───┘
         │            └───┘       reduce
         │            ┌───┐
         └───────────→│ E │──┐
                      └───┘  │
                      ...    │
```

### Failure modes

- **Skew.** One chunk is much larger; its worker becomes the straggler.
  Mitigation: dynamic re-splitting — the splitter issues smaller chunks and
  workers pull work until done (work-stealing).
- **Reducer cannot handle the map output volume.** The reduce step is serial
  and becomes the bottleneck. Mitigation: hierarchical reduce (reduce in
  tiers, then reduce the reductions) — this is map-reduce's classic combiner
  pattern.
- **Worker churn mid-chunk.** Mitigation: leases expire, chunk re-issued to a
  new worker; idempotent map functions ensure no double-counting in the
  reducer.
- **Splitter is a single point of failure.** Mitigation: the splitter is a
  discoverable capability; if it dies after splitting, the chunk list can be
  recovered from checkpoints or re-derived deterministically from the input.
- **Cost overrun on huge inputs.** Mitigation: budget enforcement in the
  economic layer; the scheduler stops issuing chunks when budget is exhausted.

---

## Pattern 7 — Pub/Sub

### When to use

Use pub/sub when an event should be broadcast to an unknown set of subscribers
that react independently and asynchronously. Examples: a "new document
ingested" event that triggers indexing, summarization, translation, and
archival agents; a "model updated" event that triggers cache invalidation
across inference agents; a "price changed" event for real-time subscribers.
The publisher does not know who subscribes and does not wait for responses.

### AAFP features needed

- **PubSub backchannel** — `PUBSUB_BACKCHANNEL_DESIGN.md` defines this. The
  protocol must support topic-based subscription and event delivery.
- **Topic discovery** — subscribers must be able to find topics. This can be
  DHT-keyed by topic name, or expressed as a capability ("subscribe:topic-X").
- **`EdgeType::Enables`** to express that a capability is *triggered by* an
  event (e.g., "index" is enabled by "document-ingested").
- **At-least-once or at-most-once delivery** — the protocol must state which.
  At-least-once requires idempotent subscribers; at-most-once requires
  durable queues.
- **Event schema** — the agent-native content representation (Strategic Vision
  §World Perception Layer) so subscribers receive structured events, not
  opaque blobs.

### Topology

```
        ┌───┐ publish "doc-ingested"
        │ A │───────────────────────────────┐
        └───┘                               │
                                            ▼
                                   ┌─────────────────┐
                                   │   topic bus     │
                                   └─────────────────┘
                                    ⇟      ⇟      ⇟
                                 ┌───┐  ┌───┐  ┌───┐
                                 │ B │  │ C │  │ D │
                                 └───┘  └───┘  └───┘
                                index  summarize translate
```

### Failure modes

- **Subscriber is down when event fires.** Mitigation: durable topics retain
  events for a TTL; a recovering subscriber catches up. Without durability,
  events are lost.
- **Event storm.** A burst of events overwhelms subscribers. Mitigation:
  rate limiting at the backchannel; subscriber-side queueing; the Adaptive
  Routing Plane can shed load.
- **Poison event.** An event that crashes every subscriber. Mitigation: dead-
  letter topic; subscribers that crash repeatedly are unsubscribed or
  quarantined by reputation.
- **No subscribers.** The event is published into the void. This is usually
  fine (pub/sub is fire-and-forget), but if the publisher needs confirmation,
  it should use a different pattern (Workflow, Pattern 8).
- **Ordering violations.** Subscribers see events out of order. Mitigation:
  per-topic sequence numbers; subscribers that care about order must
  reassemble. The protocol should document whether ordering is guaranteed
  per-topic or not.

---

## Pattern 8 — Workflow

### when to use

Use the workflow when a process has multiple steps with conditionals, loops,
and human-in-the-loop checkpoints — i.e., non-trivial control flow that cannot
be expressed as a single pipeline. Examples: a document review workflow
(draft → review → if rejected, revise → re-review → approve → publish), a
research workflow (search → if not enough, search again → summarize →
human-review → finalize), a deployment workflow (build → test → if fail,
notify human → if approved, deploy → monitor). This is the most general
pattern and typically subsumes several others internally.

### AAFP features needed

- **Workflow engine** — this is an application-layer concern, but AAFP must
  expose the primitives: capability invocation, conditional branching (client-
  side logic), and durable state. The protocol does not define a workflow
  language; it defines the RPCs the engine calls.
- **Checkpointing + durable state** (Execution Fabric) so a workflow survives
  agent restarts and can be resumed days later.
- **Human-in-the-loop RPC** — a protocol message that suspends execution and
  waits for an external (human) signal. This is a new primitive: a
  "wait-for-approval" call that blocks until a human agent (or a human via a
  UI bridge) responds.
- **Timers** — the workflow may need to fire after a delay or timeout. The
  Execution Fabric should support scheduled invocations.
- **Compensation** — if a step fails after side effects, a compensating
  capability must be invoked (the saga pattern). The capability graph should
  express `EdgeType::Alternative` for compensation.
- **Session affinity** (`SESSION_AFFINITY_DESIGN.md`) so that a workflow's
  stateful steps can pin to the same agent where relevant.

### Topology

```
        ┌───┐
 start →│ A │ draft
        └─┬─┘
          ▼
        ┌───┐
        │ B │ review
        └─┬─┘
          ▼
        <approved?> ── no ──→ back to A (loop)
          │
          yes
          ▼
        ┌───┐
        │ C │ publish
        └─┬─┘
          ▼
        ┌───┐
        │ D │ monitor
        └───┘
```

### Failure modes

- **Workflow state lost.** The engine crashes. Mitigation: durable
  checkpointing; on restart, resume from the last checkpoint. This is the
  single most important requirement for workflows.
- **Human never responds.** A human-in-the-loop step hangs forever.
  Mitigation: timeouts with escalation (notify a different human, or auto-
  approve/deny per policy).
- **Compensation fails.** A saga's compensating step also fails, leaving the
  system in an inconsistent state. Mitigation: retry with backoff; ultimately
  flag for manual intervention. The protocol should record the partial state.
- **Long-running step blocks the workflow.** Mitigation: per-step timeouts;
  the workflow engine can parallelize independent branches.
- **Workflow definition drift.** The workflow logic changes while an instance
  is running. Mitigation: version the workflow definition; running instances
  complete on their version, new instances use the new one.
- **Side effects are not idempotent.** Re-executing a step after a crash
  double-charges or double-sends. Mitigation: idempotency keys on every
  side-effecting capability invocation; the protocol should support an
  idempotency key field.

---

## Pattern 9 — Hierarchy (Supervisor / Workers)

### When to use

Use the hierarchy when a complex task is decomposed by a supervisor into
sub-tasks delegated to specialized workers, with the supervisor aggregating
and re-delegating as needed. Examples: a "research supervisor" that breaks a
research question into sub-questions, delegates each to a research worker,
aggregates, and may issue follow-up sub-tasks; a "project manager" agent that
assigns tasks to worker agents and tracks completion. Unlike fan-out/fan-in,
the hierarchy is recursive and adaptive — the supervisor can issue new
sub-tasks based on intermediate results.

### AAFP features needed

- **Supervisor capability** — a discoverable capability ("supervise",
  "decompose", "orchestrate") that takes a goal and produces sub-goals.
- **Worker capabilities** — the supervisor discovers workers for each sub-goal
  via `CapabilityQuery`.
- **Recursive orchestration** — the supervisor may itself be a worker for a
  higher supervisor. The protocol must not impose a depth limit (though
  practical latency will).
- **Streaming intermediate results** — workers stream partial results to the
  supervisor so it can decide follow-ups without waiting for completion.
- **Trust-weighted delegation** — the supervisor prefers workers with higher
  `trust_score` (Track W) for sensitive sub-tasks.
- **Capability graph traversal** — the supervisor uses `PipelineAssembler`-
  style planning to find worker chains for each sub-goal.

### Topology

```
                 ┌───────────┐
                 │     A     │ supervisor
                 └─────┬─────┘
            ┌──────────┼──────────┐
            ▼          ▼          ▼
         ┌───┐      ┌───┐      ┌───┐
         │ B │      │ C │      │ D │ workers
         └─┬─┘      └─┬─┘      └─┬─┘
           │          │          │
           ▼          ▼          ▼
        (may recurse: B delegates to B1, B2...)
                 ┌───────────┐
                 │     A     │ aggregate + re-delegate
                 └───────────┘
```

### Failure modes

- **Supervisor dies.** The whole subtree is orphaned. Mitigation: the
  supervisor's state is checkpointed; a replacement supervisor is discovered
  and resumes. Workers must be able to report to a new supervisor.
- **Worker dies mid-sub-task.** Mitigation: the supervisor detects timeout,
  re-discovers a replacement, re-issues the sub-task. Idempotency helps.
- **Supervisor over-decomposes.** It breaks work into too many tiny sub-tasks,
  adding overhead. Mitigation: a decomposition budget (max sub-tasks per
  level); the supervisor's own reputation tracks over-decomposition.
- **Recursive blowup.** Deep hierarchies add latency and failure surface.
  Mitigation: depth limit in practice; the supervisor should flatten when
  sub-tasks are simple.
- **Worker results conflict.** B and C return contradictory answers.
  Mitigation: the supervisor's aggregation capability must include
  reconciliation/voting logic; trust scores weight the vote.

---

## Pattern 10 — Market / Auction

### When to use

Use the market/auction when a task should be allocated to the agent that
values it most (or can do it best), determined by competitive bidding. This is
the Broker (Pattern 4) generalized to repeated allocation and explicit price
discovery. Examples: a compute market where agents bid for inference jobs
based on their current idle capacity; a spot-pricing market for latency-
sensitive tasks; a quality auction where the highest-accuracy agent wins.
This pattern is where the Economic Layer (Phase 7) becomes essential.

### AAFP features needed

- **Economic layer** (Phase 7) — agents must have a notion of budget, price,
  and settlement. Without it, "bidding" is meaningless.
- **Auctioneer capability** — A announces the task and collects bids. The
  auctioneer may be decentralized (DHT-gossip) rather than a single agent.
- **Bid protocol messages** — quote (price, quality, ETA), award, settle.
- **Reputation** (Track W) — agents that win bids but fail to deliver are
  penalized; their future bids are deprioritized.
- **`CapabilityQuery`** to define the task being auctioned so bidders can
  self-select (only agents with the capability bid).
- **Anti-collusion** — the open DHT means new entrants can always undercut;
  the auctioneer should solicit from the open graph, not a closed set.

### Topology

```
        ┌───────────┐ announce task + constraints
        │     A     │───────────────────────────────┐
        │ auctioneer│                               ▼
        └───────────┘                        ┌────────────┐
                                             │ open graph │
                                             └────────────┘
                                              ⇟  ⇟  ⇟
                                           ┌───┐┌───┐┌───┐
                                           │ B ││ C ││ D │ bid
                                           └───┘└───┘└───┘
                                              \  |  /
                                               \ | /
                                                ▼
                                           A selects best bid
                                                │
                                                ▼
                                           award → winner executes
```

### Failure modes

- **Winner reneges.** The winning bidder does not execute. Mitigation: escrow
  / deposit in the economic layer; reputation penalty; re-auction.
- **Auctioneer colludes with a bidder.** Mitigation: open bidding (bids are
  visible) or a decentralized auction protocol; clients can verify.
- **No bidders.** The task is too cheap/expensive/niche. Mitigation: the
  auctioneer relaxes constraints or raises the offered price and re-announces.
- **Bidding war inflates cost.** Mitigation: a reserve price ceiling; the
  client's budget caps the auction.
- **Sybil bidding.** One agent creates many identities to bid and manipulate.
  Mitigation: UCAN identity with proof-of-work or stake; reputation requires
  history, so new identities cannot immediately win large tasks.

---

## Pattern 11 — Conversation (Multi-turn with Mediator)

### When to use

Use the conversation pattern when two or more agents must engage in a multi-
turn exchange to reach a result, often with a mediator that keeps the
conversation productive. Examples: a negotiation between a buyer agent and a
seller agent with a mediator that proposes compromises; a debate between two
reasoning agents with a mediator that synthesizes; a clarification dialog
between a user agent and a service agent with a mediator that detects
misunderstanding. Unlike request/response, the conversation has state and
turns.

### AAFP features needed

- **Session affinity** (`SESSION_AFFINITY_DESIGN.md`) so the conversation
  state pins to the same agents across turns.
- **Stateful sessions** — the World Perception Layer's session standard
  (Strategic Vision) applies here: the conversation has a session ID and
  history.
- **Mediator capability** — a discoverable capability ("mediate", "moderate",
  "synthesize") that observes the turn stream and intervenes.
- **Turn protocol** — messages tagged with speaker, turn number, and
  conversation ID. This is an application-layer schema on top of AAFP RPCs.
- **Termination detection** — the mediator or one party signals "conversation
  complete" so resources are released.
- **Timeouts** — conversations can loop forever; the protocol must support
  inactivity timeouts.

### Topology

```
        ┌───┐                     ┌───┐
        │ B │ ←──────────────────→ │ C │
        │buyer│   turn 1,2,3...    │seller│
        └─┬─┘                     └─┬─┘
          │                         │
          └──────────┬──────────────┘
                     ▼
                 ┌───────┐
                 │   A   │ mediator
                 └───────┘
                  proposes, synthesizes, detects deadlock
```

### Failure modes

- **Infinite loop.** B and C repeat without converging. Mitigation: the
  mediator detects repetition and forces termination or a compromise.
- **Party drops mid-conversation.** Mitigation: session timeout; the mediator
  can summarize the state so a replacement party can continue, or declare the
  conversation failed.
- **Mediator is biased.** A steers the conversation toward one party.
  Mitigation: the mediator's logic is itself a capability whose reputation is
  tracked; parties can refuse a mediator and request another.
- **Conversation state divergence.** B and C have different views of the
  history. Mitigation: the session is the source of truth; every turn is
  appended to the session log and parties read from it.
- **Cost runaway.** Long conversations accumulate token costs. Mitigation:
  budget enforcement per conversation; the mediator enforces a turn cap.

---

## Pattern 12 — Swarm

### When to use

Use the swarm when emergent behavior is desired from many simple agents
interacting locally, with no central controller. Examples: a swarm of
exploration agents that cover a search space and share findings with
neighbors; a swarm of optimization agents that iteratively improve a solution
via local perturbations; a swarm of monitoring agents that collectively detect
anomalies. This is the most ambitious pattern and the one closest to the
Strategic Vision's "design for emergent intelligence" principle. It is also
the hardest to debug.

### AAFP features needed

- **Peer-to-peer gossip** — agents share state with neighbors, not via a
  central coordinator. The DHT and PEX provide the neighbor graph.
- **Local rules** — each agent runs a simple policy; the protocol does not
  define the policy, only the communication.
- **Convergence detection** — some external observer (or a designated agent)
  must detect when the swarm has converged or should stop.
- **Reputation propagation** — trust scores propagate through the swarm so
  bad actors are collectively shunned (Strategic Vision: "automatic trust
  propagation").
- **Adaptive Routing Plane** (Track T) — the swarm's collective state is
  exactly the kind of distributed metric the routing plane shares.
- **No single point of control** — the protocol must not require a leader;
  any agent can join or leave without breaking the swarm.

### Topology

```
        ┌───┐     ┌───┐     ┌───┐
        │ • │─────│ • │─────│ • │
        └─┬─┘     └─┬─┘     └─┬─┘
          │         │         │
        ┌─┴─┐     ┌─┴─┐     ┌─┴─┐
        │ • │─────│ • │─────│ • │
        └─┬─┘     └─┬─┘     └─┬─┘
          │         │         │
        ┌─┴─┐     ┌─┴─┐     ┌─┴─┐
        │ • │─────│ • │─────│ • │
        └───┘     └───┘     └───┘
        each • is an agent; edges are local gossip
        emergent global behavior from local rules
```

### Failure modes

- **No convergence.** The swarm oscillates or drifts. Mitigation: dampening in
  local rules; a convergence detector that halts after a budget. This is
  largely an application-layer concern.
- **Byzantine agents.** A malicious agent injects bad data. Mitigation:
  trust-weighted gossip; agents discount neighbors with low reputation;
  quorum requirements for accepting a finding.
- **Cascade failure.** One agent's bad output propagates to all neighbors.
  Mitigation: bounded fanout per agent; reputation decay for agents that
  propagate later-corrected information.
- **Unbounded growth.** The swarm keeps spawning agents. Mitigation: a
  population cap; the economic layer charges for agent existence.
- **Unobservable.** No one knows what the swarm is doing. Mitigation: an
  observer capability that samples swarm state; the routing plane aggregates
  metrics for visibility.
- **Non-determinism.** The same input produces different outputs across runs.
  This is inherent to swarms; the protocol should not promise determinism.
  Applications that need determinism should use a Workflow instead.

---

## Cross-Cutting Concerns

### Observability

Every pattern produces distributed traces. The protocol should support a
trace context (correlation ID) propagated across capability invocations so
that a pipeline, fan-out, or hierarchy can be reconstructed after the fact.
This is an Execution Fabric concern (Phase 4).

### Idempotency

Patterns with retry (Pipeline, Chain, Map-Reduce, Workflow, Hierarchy) require
idempotent capability invocations. The protocol should support an idempotency
key field on RPCs so that a retried call is deduplicated by the provider.

### Budget enforcement

Patterns with cost explosion (Fan-out, Map-Reduce, Market, Conversation,
Swarm) need budget enforcement. The economic layer (Phase 7) must track
spend per orchestration and halt when exhausted.

### Trust propagation

In every pattern, the trust score of participants affects routing. The
reputation system (Track W) must record outcomes (success, failure, latency,
cost) and feed them back into `QualityMetrics` so future orchestrations
benefit. This closes the Strategic Vision's "Request → Outcome → Learning →
Routing improves" loop.

### Checkpointing

Patterns with long-running or stateful execution (Pipeline, Map-Reduce,
Workflow, Hierarchy, Conversation) require checkpointing. The Execution
Fabric must checkpoint at synchronization points (fan-in bars, workflow
steps, conversation turns) so that recovery does not restart from zero.

### Security

- **Capability spoofing** (per `SEMANTIC_CAPABILITY_GRAPHS.md` §12): UCAN
  attestation that an agent actually has the capability it advertises.
- **Graph poisoning**: trust-weighted edges; consensus on graph structure for
  critical pipelines.
- **Query injection**: complexity limits on `CapabilityQuery` to prevent
  resource exhaustion via malicious queries.
- **Sybil attacks**: especially relevant to Market and Swarm; mitigated by
  identity cost (UCAN + proof-of-work or stake) and reputation requiring
  history.

---

## Pattern Selection Guide

| If the task is... | Use pattern |
|---|---|
| A fixed sequence of transforms | Pipeline |
| Independent sub-tasks aggregated | Fan-out/Fan-in |
| One of N handlers by content | Router |
| Multi-dimensional match with price/SLA | Broker |
| First-that-can-succeed fallback | Chain of Responsibility |
| Parallel over a large splittable input | Map-Reduce |
| Broadcast to unknown subscribers | Pub/Sub |
| Conditionals, loops, human approval | Workflow |
| Recursive decomposition with aggregation | Hierarchy |
| Competitive allocation with pricing | Market/Auction |
| Multi-turn negotiation/debate | Conversation |
| Emergent behavior from simple agents | Swarm |

### Composing patterns

Real orchestrations nest patterns. Examples:

- A **Workflow** whose "research" step is a **Hierarchy** whose supervisor
  uses **Fan-out** to query multiple sources and **Map-Reduce** to synthesize.
- A **Pipeline** whose OCR stage is a **Broker** that picks the best OCR
  engine per image.
- A **Market** where the winning bidder executes a **Pipeline** and the
  loser pays nothing.
- A **Swarm** whose convergence is detected by a **Hierarchy** supervisor.

The protocol's job is to provide the primitives (discovery, invocation,
streaming, checkpointing, sessions, pub/sub, economic accounting) so that any
composition is expressible. The patterns above are the vocabulary; the
Execution Fabric is the grammar.

---

## Requirements Summary (by AAFP component)

| Component | Patterns that require it | Source doc |
|---|---|---|
| Semantic capability graph | All (discovery is universal) | `SEMANTIC_CAPABILITY_GRAPHS.md` |
| `PipelineAssembler` | Pipeline, Hierarchy, Workflow | §6 of above |
| Streaming RPC | Pipeline, Fan-out, Hierarchy, Conversation | `STREAMING_RPC_DESIGN.md` |
| Checkpointing | Pipeline, Map-Reduce, Workflow, Hierarchy, Conversation | Execution Fabric (Phase 4) |
| Adaptive Routing Plane | Router, Broker, Market, Swarm | Track T |
| Reputation | Router, Broker, Chain, Market, Hierarchy, Swarm | Track W |
| Economic layer | Broker, Market, (Fan-out, Map-Reduce for budgets) | Phase 7 |
| Pub/sub backchannel | Pub/Sub, Swarm | `PUBSUB_BACKCHANNEL_DESIGN.md` |
| Session affinity | Workflow, Conversation | `SESSION_AFFINITY_DESIGN.md` |
| Human-in-the-loop RPC | Workflow | New primitive (Phase 4) |
| Bid/quote RPC | Broker, Market | New primitive (Phase 7) |
| Idempotency keys | Pipeline, Chain, Map-Reduce, Workflow, Hierarchy | Protocol extension |
| Trace context | All | Execution Fabric (Phase 4) |

---

## Open Questions

1. **Should the protocol define a workflow language?** The Strategic Vision
   says "bake interfaces, not algorithms." A workflow language is an
   algorithm. Recommendation: do not standardize a language; standardize the
   RPCs and state primitives that any workflow engine can call.

2. **Is the Broker a protocol-level concept or an application pattern?** The
   bid/quote RPC is protocol-level; the matching logic is application-level.
   The protocol should define the quote message, not the matching algorithm.

3. **How does the Swarm stay observable without a central observer?** The
   Adaptive Routing Plane's distributed metrics are the partial answer. A
   dedicated "sampling observer" capability may be needed.

4. **Does the Market require cryptocurrency?** No. The Strategic Vision
   explicitly says AAFP does not need cryptocurrency; it needs a "resource
   accounting model." The economic layer can be fiat-pegged or pure accounting
   without settlement.

5. **What is the maximum practical hierarchy depth?** Unbounded in protocol,
   bounded by latency in practice. A guideline (e.g., depth ≤ 5) belongs in
   SDK documentation, not the protocol.

6. **How do patterns interact with the immutable boundary?** The wire
   protocol (transport, framing, identity) is frozen. All pattern semantics
   live above it — in the SDK, the Execution Fabric, and the intelligence
   layers. No pattern requires a change to the frozen wire format.

---

## Conclusion

The twelve patterns cover the space of multi-agent orchestration from the
simplest linear pipeline to emergent swarms. Each maps onto specific AAFP
features, most of which are already designed in existing docs
(`SEMANTIC_CAPABILITY_GRAPHS.md`, `STREAMING_RPC_DESIGN.md`,
`PUBSUB_BACKCHANNEL_DESIGN.md`, `SESSION_AFFINITY_DESIGN.md`) or planned
(Execution Fabric Phase 4, Adaptive Routing Track T, Reputation Track W,
Economic Layer Phase 7). The two genuinely new primitives the patterns
collectively demand are:

1. **Human-in-the-loop RPC** (suspend execution pending external signal) —
   required by Workflow.
2. **Bid/quote RPC** (solicit a priced quote before execution) — required by
   Broker and Market.

Both sit above the frozen wire protocol and should be specified as Execution
Fabric extensions, not transport changes. With those two additions and the
already-planned components, AAFP can express every pattern in this document,
fulfilling the Strategic Vision's goal of "automatically assembling
pipelines" and delivering "execution, not bytes."
