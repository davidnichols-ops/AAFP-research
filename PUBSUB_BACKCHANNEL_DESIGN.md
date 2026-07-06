# PubSub + Back-Channeling Design Document

**Status:** Design Proposal
**Date:** 2026-07-02
**Depends on:** RFC-0009 (PubSub), RFC-0002 (Framing), `STREAMING_RPC_DESIGN.md`, `SIMPLE_API_V2_DESIGN.md`
**Addresses:** Adaptation Roadmap Gap #11 (RFC-0009 PubSub not exposed via Simple API), Track E "PubSub + Back-Channeling"

---

## Executive Summary

AAFP already defines a networked PubSub protocol (RFC-0009) and ships a working
`NetworkedPubSub` implementation in `aafp-messaging/src/pubsub_v1.rs`. Neither is
exposed through the Simple API (`aafp-sdk/src/simple.rs`), which today only offers
a unary request-response pattern. This document proposes:

1. A **Simple API surface for PubSub** — subscribe, publish, topic streams — that
   hides the floodsub/CBOR/RPC plumbing behind ergonomic builder methods.
2. A **back-channeling** mechanism that lets a server push progress/lifecycle
   events to a client *during* a long-running RPC, on a separate logical channel
   that does not interfere with the response stream.
3. **Topic-based routing** with hierarchical topics, wildcard subscriptions, and
   per-topic ACLs rooted in UCAN capability chains.
4. A unified view in which **streaming RPC is a specialized, point-to-point form
   of PubSub** — both are "frames delivered on a stream keyed by a topic/request-id".

The design requires **no wire protocol changes**: it reuses RFC-0009 RPC methods,
RFC-0002 frames/extensions, and QUIC uni/bi-streams. All new behavior lives in the
SDK layer.

---

## 1. Analysis of RFC-0009 and the Existing Implementation

### 1.1 What RFC-0009 Defines

`RFCs/0009-pubsub.md` (151 lines, Experimental, v0.1.0) specifies a networked
publish/subscribe layer:

- **Three RPC methods** carried over standard AAFP RPC frames (RFC-0002 §4.4):
  - `aafp.pubsub.subscribe` — `{ 1: tstr }` (topic)
  - `aafp.pubsub.unsubscribe` — `{ 1: tstr }` (topic)
  - `aafp.pubsub.publish` — `{ 1: tstr, 2: bstr, 3: uint, 4: [*bstr] }`
    (topic, data, ttl, seen-list)
- **Floodsub v1**: every published message is forwarded to *all* known peers
  subscribed to the topic. A `seen` list of AgentIds prevents loops; a TTL
  (default 3) bounds hop count.
- **Gossipsub v2** is documented as future work — the wire format is forward
  compatible, only the propagation logic changes.
- **Security**: messages ride authenticated AAFP connections; `from` is verified
  against the connection's peer AgentId; subscriptions are per-connection and
  cleaned up on close.

Notably, RFC-0009 is **request-response shaped**: `publish` is an RPC call that
returns `{}`. There is *no* defined mechanism for the server to push messages *to*
a subscriber — the protocol only tracks who is subscribed and forwards publishes.
The actual delivery of forwarded messages to a subscriber happens as inbound
`aafp.pubsub.publish` RPC requests on the subscriber's connection. This is an
important asymmetry the Simple API must paper over (see §3.2).

### 1.2 Existing Implementation

Two modules exist in `aafp-messaging`:

**`pubsub.rs`** (legacy stub, 192 lines): an in-memory `PubSub` struct backed by
`tokio::sync::broadcast` channels. No network propagation. Exposed via
`pub use pubsub::{PubSub, Topic, TopicMessage}` in `lib.rs`.

**`pubsub_v1.rs`** (RFC-0009 implementation, 793 lines): the real implementation.
Key types:

- `NetworkedPubSub` — holds `local: HashMap<Topic, broadcast::Sender<TopicMessage>>`
  and `remote: Arc<Mutex<HashMap<Topic, HashSet<AgentId>>>>`. Tracks both local
  subscribers (via broadcast channels) and remote peer subscriptions.
- `SubscribeParams` / `UnsubscribeParams` / `PublishParams` — CBOR
  encode/decode per RFC-0009 §2. `PublishParams` carries `topic`, `data`, `ttl`,
  `seen: Vec<AgentId>`.
- `SeenCache` — 60s TTL, 10K cap, LRU eviction. `check_and_mark()` is the atomic
  dedup primitive used by `handle_remote_message()`.
- `PubSubRpcHandler` — dispatches `METHOD_SUBSCRIBE`/`UNSUBSCRIBE`/`PUBLISH` RPC
  requests, mutates remote subscription state, and delivers published messages to
  local broadcast channels.

What's **missing** for the Simple API:

1. No integration with `ServeBuilder`/`ConnectedAgent` in `simple.rs`. The handler
   loop (lines 222-298) only dispatches the generic `"call"` method.
2. No client-side `subscribe()` that opens a long-lived stream and yields events.
3. No propagation driver — nothing currently *sends* `aafp.pubsub.publish` frames
   to remote peers. `encode_publish_request()` exists but is never called by the
   SDK. `remote_subscribers()` is exposed but unused.
4. No back-channeling: a long RPC has no way to emit side-channel events.

### 1.3 Gap in the Adaptation Roadmap

`ADAPTATION_ROADMAP.md` lists Gap #11 ("RFC-0009 PubSub not exposed via simple
API") and Phase E "PubSub + Back-Channeling" with dependency on Phase B
(Streaming RPC). The dependency is correct: PubSub event delivery reuses the same
"keep a QUIC stream open and read frames in a loop" pattern that streaming RPC
introduces. This document fulfills that pending research track.

---

## 2. PubSub Patterns Agents Need

Four distinct patterns emerged from the sandbox gap analyses (event-driven
webhooks, streaming + human-in-the-loop):

### 2.1 Subscribe-to-Topic, Receive-Events

An agent declares interest in a topic and receives an async stream of events.
This is the core fan-out primitive. Use cases: tool-result notifications,
multi-agent coordination ("agent A finished subtask, notify agent B").

### 2.2 Publish-to-Topic

An agent emits an event to a topic without knowing subscribers. Decoupled,
fire-and-forget. Use cases: telemetry, task-completion broadcasts, log fan-out.

### 2.3 Request-Response with Back-Channel

A client issues a long-running RPC. While it runs, the server pushes
progress/heartbeat/partial-result events to the client on a *separate* channel,
without consuming the response stream. The final response still arrives on the
original bi-stream. Use cases: long LLM generation with progress, RAG pipeline
stage updates, human-in-the-loop approval prompts.

### 2.4 Webhook Registration

An agent registers a callback (either an AAFP topic subscription or an external
HTTP URL) that another agent will deliver events to. Use cases: bridging AAFP
events to HTTP webhooks for non-AAFP integrations, durable event delivery when
the subscriber is offline (via a relay).

Patterns 2.1–2.2 are pure PubSub. Pattern 2.3 is back-channeling (§5). Pattern
2.4 is a thin adapter on top of 2.1 (§6).

---

## 3. Proposed Simple API for PubSub

### 3.1 Server Side

```rust
use aafp_sdk::simple::{Agent, Request, Response, Event};
use futures::stream::StreamExt;

// Serve an agent that both handles RPCs and hosts PubSub topics.
let serving = Agent::serve()
    .capability("translate")
    .handler(|req: Request| async move { Ok(Response::text(translate(req.body()))) })
    // Declare a topic this agent publishes to.
    .topic("translate.events")
    // Declare a topic this agent subscribes to and reacts to.
    .on_publish("commands", |topic, msg: Event| async move {
        if msg.body() == "shutdown" {
            // react to a published command
        }
    })
    .start()
    .await?;
```

`ServeBuilder` gains two new methods:

- `.topic(name)` — registers a topic the agent may publish to. The builder wires
  a `NetworkedPubSub` instance into the serving agent and registers an RPC
  dispatch arm for `aafp.pubsub.*` methods alongside the existing `"call"` arm.
- `.on_publish(topic, handler)` — subscribes locally and invokes `handler` for
  each event. This is sugar for `subscribe()` + a spawned consumer task.

### 3.2 Client Side

```rust
let agent = Agent::connect().connect().await?;

// Subscribe to a topic and receive a stream of events.
let mut events = agent.subscribe("translate.events").await?;

while let Some(event) = events.next().await {
    println!("event from {}: {}", event.from(), event.body());
}

// Publish to a topic (fire-and-forget).
agent.publish("commands", Event::text("shutdown")).await?;
```

`subscribe()` returns `impl Stream<Item = Result<Event, SdkError>>`. Under the
hood it:

1. Sends an `aafp.pubsub.subscribe` RPC request on a bi-stream (and keeps the
   connection in the pool).
2. Spawns a listener that accepts inbound `aafp.pubsub.publish` RPC requests on
   *server-initiated bi-streams* (the server dials back, or — more simply for v1
   — forwards publishes on the same connection using a long-lived bi-stream the
   client opens and keeps open). The chosen transport mapping is detailed in §7.
3. Decodes each `PublishParams` into an `Event` and pushes it to an
   `mpsc::Receiver` that backs the returned stream.

`publish()` sends an `aafp.pubsub.publish` RPC request. The SDK's propagation
driver (new, §3.3) forwards the message to all `remote_subscribers(topic)`.

### 3.3 Propagation Driver

A new background task in `ServingAgent` closes the loop that `pubsub_v1.rs` left
open. After a local `publish`, it queries `remote_subscribers(topic)`, computes
the `seen` list, decrements TTL, and sends `aafp.pubsub.publish` RPC frames to
each peer over pooled connections.

```rust
// Inside ServingAgent::start(), after handler loop spawn:
let pubsub = Arc::clone(&pubsub);
let pool = Arc::clone(&connection_pool);
tokio::spawn(async move {
    let mut rx = pubsub.local_publish_events(); // broadcast of local publishes
    while let Some((topic, from, data)) = rx.recv().await {
        let peers = pubsub.remote_subscribers(&topic);
        let mut seen = pubsub.seen_for(&topic, from); // includes our_id + from
        for peer in peers {
            if seen.contains(&peer) { continue; }
            let payload = pubsub.encode_publish_request(
                &topic, data.clone(), DEFAULT_TTL - 1, seen.clone())?;
            seen.push(peer);
            if let Some(conn) = pool.get(&peer).await {
                let _ = send_publish_rpc(&conn, payload).await;
            }
        }
    }
});
```

### 3.4 `Event` Type

```rust
/// A PubSub event delivered to a subscriber.
#[derive(Debug, Clone)]
pub struct Event {
    topic: String,
    from: AgentId,
    text: String,
    data: Option<Vec<u8>>,
}

impl Event {
    pub fn text(s: impl Into<String>) -> Self { /* ... */ }
    pub fn data(d: Vec<u8>) -> Self { /* ... */ }
    pub fn topic(&self) -> &str { &self.topic }
    pub fn from(&self) -> AgentId { self.from }
    pub fn body(&self) -> &str { &self.text }
    pub fn payload(&self) -> Option<&[u8]> { self.data.as_deref() }
}
```

`Event` mirrors `Request`/`Response` ergonomics and wraps `TopicMessage` from
`pubsub_v1.rs`.

---

## 4. Comparison with Other Agent Event Systems

### 4.1 LangChain Callbacks

LangChain uses a synchronous callback handler trait (`BaseCallbackHandler`) with
methods like `on_llm_new_token`, `on_chain_start`, `on_tool_end`. It is
**in-process only** — no network propagation, no topic routing, no cross-agent
delivery. AAFP's PubSub is the networked analog: an `on_publish` handler is the
remote equivalent of `on_llm_new_token`, but routed by topic across agents.

**Lesson**: LangChain's typed event categories (LLM/Chain/Tool/Agent) map cleanly
to AAFP topic hierarchies (`llm.tokens`, `chain.start`, `tool.end`). We recommend
a topic naming convention (§6.2) rather than typed event enums, to keep the wire
format generic.

### 4.2 AutoGen Event System

AutoGen (Microsoft) uses a `Runtime` abstraction with an event queue and
`publish_message` / message routing by agent ID. It supports both direct
(point-to-point) and broadcast (topic) delivery, backed by gRPC or in-process
channels. Key features: typed messages, agent-id routing, cancellation via
`CancellationEvent`.

**Lesson**: AutoGen's agent-id routing is a special case of AAFP topic routing
(topic = `agent.<id>.inbox`). AutoGen's typed messages argue for a CBOR Map
payload convention (RFC-0006 extension) rather than raw bytes — the `Event` type
should encourage structured payloads.

### 4.3 Kafka / RabbitMQ for Agent Communication

Production multi-agent systems often use Kafka (partitioned, durable, log-based)
or RabbitMQ (queue-based, AMQP exchanges with routing keys). Both support
durable delivery, consumer groups, and wildcard topic matching (RabbitMQ topic
exchanges: `logs.*.error`).

**Lesson**: AAFP PubSub v1 is **best-effort, non-durable** (floodsub, in-memory).
For durable/webhook semantics (Pattern 2.4), we need a relay-based persistence
layer (RFC-0010 circuit relay can host a durable broker). Wildcard routing
(§6.3) borrows from RabbitMQ's topic-exchange semantics.

### 4.4 MQTT for IoT Agents

MQTT is topic-hierarchical (`home/living_room/temperature`), supports wildcards
(`home/+/temperature`, `home/#`), QoS levels (0=fire-and-forget, 1=at-least-once,
2=exactly-once), retained messages, and last-will messages.

**Lessons adopted**:
- **Hierarchical topics with `/` separators** and `+`/`#` wildcards (§6.3).
- **QoS 0 default** (matches floodsub); QoS 1 (at-least-once) is a future
  gossipsub + ack extension.
- **Retained messages** are a natural fit for "latest state" topics
  (`agent.<id>.status`) — proposed as a future extension.
- **Last-will** maps to AAFP's connection-close cleanup (RFC-0009 §5 already
  removes subscriptions on disconnect; we extend it to publish a will message).

---

## 5. Back-Channeling Design for Long-Running RPCs

### 5.1 The Problem

The streaming RPC design (`STREAMING_RPC_DESIGN.md` §8) proposes interleaving
progress frames *on the same bi-stream* as response frames. This works but has
two drawbacks:

1. The client must demultiplex progress vs data frames on a single stream.
2. A third party (e.g., a human approver in a HITL loop) cannot observe progress
   without being the RPC caller.

Back-channeling solves both by pushing events to a **separate topic** keyed by
the request, decoupling progress delivery from the response stream.

### 5.2 Back-Channel Topic Convention

For an RPC with request id `req_id` to agent `server_id`, the server publishes
progress to topic:

```
rpc.<server_id>.<req_id>.progress
```

The client subscribes to this topic *before* issuing the RPC (or the SDK
auto-subscribes as part of `call_with_backchannel()`). The server's handler
receives a `Backchannel` handle to publish progress:

```rust
/// Handle given to a handler so it can emit back-channel events.
pub struct Backchannel {
    topic: String,
    pubsub: Arc<NetworkedPubSub>,
}

impl Backchannel {
    /// Emit a progress event to the back-channel topic.
    pub async fn progress(&self, percent: u8, msg: impl Into<String>) {
        let event = Event::text(format!("[{}%] {}", percent, msg.into()));
        self.pubsub.publish_local(&self.topic, our_id, event.encode()).ok();
    }

    /// Emit a structured partial result.
    pub async fn partial(&self, data: Vec<u8>) {
        self.pubsub.publish_local(&self.topic, our_id, data).ok();
    }

    /// Request human approval; the approver publishes to the same topic.
    pub async fn request_approval(&self, prompt: String) {
        self.progress(50, format!("APPROVAL_REQUIRED: {prompt}")).await;
    }
}
```

### 5.3 Handler Signature

```rust
/// Handler that can emit back-channel events during a long RPC.
pub type BackchannelHandlerFn = Arc<
    dyn Fn(Request, Backchannel, CancellationToken)
        -> Pin<Box<dyn Future<Output = Result<Response, String>> + Send>>
        + Send + Sync,
>;

impl ServeBuilder {
    pub fn backchannel_handler<F, Fut>(mut self, f: F) -> Self
    where
        F: Fn(Request, Backchannel, CancellationToken) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Response, String>> + Send + 'static,
    {
        self.backchannel_handler = Some(Arc::new(move |req, bc, cancel| Box::pin(f(req, bc, cancel))));
        self
    }
}
```

### 5.4 Client API

```rust
let agent = Agent::connect().connect().await?;

// Call with a back-channel: returns (response future, progress stream).
let (resp_fut, mut progress) = agent
    .discover("long.task")
    .call_with_backchannel(Request::text("process 10k docs"))
    .await?;

// Consume progress concurrently with the RPC.
let progress_task = tokio::spawn(async move {
    while let Some(ev) = progress.next().await {
        eprintln!("progress: {}", ev?.body());
    }
});

let result = resp_fut.await?;
progress_task.await?;
```

`call_with_backchannel()`:

1. Generates a unique `req_id`.
2. Subscribes to `rpc.<server_id>.<req_id>.progress`.
3. Sends the RPC request with an extension (RFC-0006) carrying the back-channel
   topic, so the server knows where to publish.
4. Returns `(ResponseFuture, ProgressStream)`.

### 5.5 Wire Mapping (No Changes)

The back-channel uses *existing* RFC-0009 publish frames on a *separate* QUIC
stream from the RPC bi-stream. The only addition is an RFC-0006 extension on the
`RPC_REQUEST` frame advertising the back-channel topic:

```rust
// Extension type 0x0010: back-channel topic
pub const EXT_BACKCHANNEL_TOPIC: u16 = 0x0010;

let ext = Extension::new(EXT_BACKCHANNEL_TOPIC, encode_cbor_text(&bc_topic));
let frame = Frame::data(0, rpc_bytes).with_extension(ext);
```

Servers that don't understand the extension ignore it (RFC-0006 graceful
degradation), so the call degrades to a plain unary RPC — fully backward
compatible.

### 5.6 Sequence Diagram

```
Client                                 Server
  |                                      |
  |--- subscribe(rpc.S.<id>.progress) -->|  [PubSub subscribe]
  |                                      |
  |--- RPC_REQUEST(id, +bc_topic ext) -->|  [bi-stream A]
  |                                      | [Handler starts, gets Backchannel]
  |<-- publish(progress 10%) ------------|  [PubSub, separate stream]
  |<-- publish(progress 50%) ------------|
  |<-- publish(APPROVAL_REQUIRED) -------|  [HITL: human publishes approval]
  |--- publish(approved) --------------->|  [PubSub back to server]
  |                                      | [Handler resumes]
  |<-- RPC_RESPONSE(id, final) ----------|  [bi-stream A]
  |                                      |
```

---

## 6. Topic-Based Routing and Security

### 6.1 Topic Hierarchies

Topics are slash-separated hierarchical strings, MQTT-style:

```
agents.<agent_id>.status        # presence/status
agents.<agent_id>.inbox         # direct message (AutoGen-style)
llm.<model>.tokens              # token stream
rpc.<server_id>.<req_id>.progress  # back-channel
tasks.<task_id>.events          # task lifecycle
```

Hierarchies enable scoped subscriptions and future retained-message semantics.

### 6.2 Naming Conventions

Reserved top-level segments (registered in a future RFC amendment):

| Prefix    | Meaning                                  |
|-----------|------------------------------------------|
| `agents.` | Per-agent topics (status, inbox)         |
| `rpc.`    | Back-channel topics for in-flight RPCs   |
| `tasks.`  | Task lifecycle events                    |
| `llm.`    | LLM generation events                    |
| `tools.`  | Tool execution events                    |

Unprefixed topics are application-defined.

### 6.3 Wildcard Subscriptions

Borrowed from MQTT/RabbitMQ topic exchanges:

- `+` — single-level wildcard. `agents.+.status` matches any agent's status.
- `#` — multi-level wildcard (must be last). `tasks.#` matches all task events.

Implementation: `NetworkedPubSub` gains a `wildcard_subscribers` map
`Vec<String> → broadcast::Sender`. On publish, the topic is matched against both
exact and wildcard entries. Matching is a simple segment-by-segment compare
(O(depth)), negligible vs. floodsub forwarding cost.

```rust
fn topic_matches(filter: &[&str], topic: &[&str]) -> bool {
    let mut fi = 0;
    for (i, seg) in topic.iter().enumerate() {
        match filter.get(fi) {
            Some(&"#") => return true,           // multi-level, rest matches
            Some(&"+") | Some(s) if *s == *seg || *s == "+" => fi += 1,
            _ => return false,
        }
    }
    fi == filter.len() || matches!(filter.get(fi), Some(&"#"))
}
```

### 6.4 Security: ACLs via UCAN

RFC-0009 §5 authenticates the `from` field but defines *no* authorization — any
authenticated peer can subscribe to or publish on any topic. For real deployments
this is insufficient.

**Proposal**: topic ACLs rooted in UCAN capability chains (RFC-0003).

- A *capability* is a string `pubsub/<topic>/<action>` where action is
  `publish` or `subscribe`.
- An agent may publish/subscribe only if it holds a UCAN attestation granting
  that capability, signed by the topic *owner* (the agent that first advertised
  the topic, or an explicit ACL publisher).
- Wildcards in capabilities: `pubsub/tasks.*/subscribe` grants subscribe on all
  `tasks.*` topics.

```rust
pub struct TopicAcl {
    /// owner -> set of granted (topic_pattern, action)
    grants: HashMap<AgentId, Vec<(String, TopicAction)>>,
}

impl TopicAcl {
    pub fn check(&self, caller: &AgentId, topic: &str, action: TopicAction) -> bool {
        self.grants.get(caller).is_some_and(|caps| {
            caps.iter().any(|(pat, act)| {
                *act == action && pattern_matches(pat, topic)
            })
        })
    }
}
```

The `PubSubRpcHandler` is extended to consult an `AuthorizationProvider` (already
a trait in `aafp-core`) before mutating subscription state or accepting a
publish. Unauthorized requests return an RPC error with code `9006
PUBSUB_UNAUTHORIZED` (new code, RFC-0005 extension).

Default policy for backward compatibility: **allow all** (matches current
RFC-0009 behavior). Operators opt into ACL enforcement by providing an
`AclAuthorizationProvider` to `ServeBuilder`.

### 6.5 Per-Connection Subscription Limits

To prevent resource exhaustion (a peer subscribing to millions of topics):

- `max_subscriptions_per_connection` (default 1024) enforced in
  `PubSubRpcHandler::handle_subscribe`.
- `max_topic_length` (default 256), `max_topic_depth` (default 16).
- Rate limit publish calls per connection (reuse the existing per-IP limiter in
  `aafp-sdk/src/server.rs`).

---

## 7. Integration with Streaming RPC and QUIC

### 7.1 Streaming as Specialized PubSub

A streaming RPC (server-streaming) is conceptually a PubSub subscription to a
topic with exactly one subscriber (the caller), where the topic is scoped to the
request. The back-channel design (§5) makes this explicit: `rpc.<id>.progress`
*is* a PubSub topic. The response stream itself can be viewed as a private topic
`rpc.<id>.response` with a single consumer.

Unification benefits:
- One frame-reading loop serves both streaming RPC responses and PubSub events.
- Cancellation (QUIC stream reset) and backpressure (QUIC flow control) apply
  uniformly.
- Future gossipsub can route streaming responses through the mesh for
  load-balanced fan-out (advanced).

The implementations remain separate code paths for now (streaming RPC uses a
dedicated bi-stream; PubSub uses the propagation driver), but share the
`Stream<Item = Result<Event/Response>>` ergonomics and the `CancellationToken`
machinery from `STREAMING_RPC_DESIGN.md` §6.

### 7.2 QUIC Stream Mapping for PubSub

RFC-0009 is silent on *which* QUIC streams carry forwarded publishes. Two
options:

**Option A — Bi-stream per publish (request-response)**: each forwarded publish
is a normal RPC request on a fresh bi-stream. Simple, matches RFC-0009's
request-response shape, but high overhead (one stream per event) and the
subscriber must `accept_bi()` in a loop.

**Option B — Long-lived uni-stream for events (recommended)**: the subscriber,
upon `subscribe()`, opens a *unidirectional* stream (QUIC uni-streams, currently
unused per `STREAMING_RPC_DESIGN.md` §1.4) and sends the subscribe request on
it. The server then pushes `aafp.pubsub.publish` frames *as DATA frames on a
server-initiated uni-stream* (or on the same connection using a dedicated
bi-stream kept open). This is the SSE/WebTransport push pattern.

```rust
// Client side: open uni-stream, send subscribe, then read events forever.
let mut send = conn.open_uni().await?;       // client -> server: subscribe request
send.write_all(&subscribe_frame).await?;
send.finish();

let mut recv = conn.accept_uni().await?;     // server -> client: event stream
// (or: server opens uni-stream back to client after seeing the subscribe)
loop {
    let frame = read_frame(&mut recv).await?;
    let event = decode_publish(&frame.payload)?;
    tx.send(Ok(event)).await?;
}
```

**Recommendation**: v1 uses **Option A** for simplicity and RFC compliance (no
new stream semantics). Option B is a v2 optimization that pairs with gossipsub
and requires a small RFC-0009 amendment documenting uni-stream usage. The Simple
API abstracts the choice, so users see `subscribe() -> Stream<Event>` either way.

### 7.3 Back-Channel Transport

The back-channel (§5) uses Option A bi-streams for each progress event, since
progress events are infrequent relative to the RPC duration. For high-frequency
progress (e.g., per-token), the handler should instead use the streaming RPC
response stream directly (cheaper, no per-event stream overhead). The
`Backchannel` API is identical either way; only the transport differs.

### 7.4 Datagram Option (Future)

QUIC datagrams (unreliable, unordered, no flow control per-stream) are ideal for
high-frequency, loss-tolerant events (telemetry, heartbeats). `STREAMING_RPC_DESIGN.md`
§9.2 notes datagrams are "not yet exposed". A future `Event::datagram()` path
could publish via datagrams for topics marked `qos: 0, lossy: true`. Out of
scope for this design.

---

## 8. Webhook Registration (Pattern 2.4)

### 8.1 AAFP-Native Webhooks

An agent that wants durable, offline-capable event delivery registers a topic
subscription with a **relay** (RFC-0010 circuit relay) acting as a broker. The
relay buffers events while the subscriber is offline and forwards them when it
reconnects. This is the AAFP-native equivalent of an HTTP webhook.

```rust
// Subscriber registers a durable subscription via a relay.
agent.subscribe("tasks.123.events")
    .durable(via_relay="relay.example")
    .await?;
```

### 8.2 HTTP Webhook Bridge

For non-AAFP consumers, a bridge agent subscribes to an AAFP topic and POSTs
each event to an HTTP URL:

```rust
Agent::serve()
    .on_publish("tasks.123.events", |_topic, ev| async move {
        let _ = reqwest::Post(&callback_url).json(&ev.body()).await;
    })
    .start().await?;
```

This is a 10-line adapter built entirely on the §3 API — no new protocol needed.

---

## 9. Implementation Roadmap

### Phase P1: Local PubSub Surface (Weeks 1-2)

**Goal**: Expose in-memory PubSub through the Simple API; no network propagation
yet.

| Step | Deliverable |
|------|-------------|
| 1 | `Event` type in `simple.rs` |
| 2 | `ServeBuilder::topic()`, `on_publish()` |
| 3 | `ConnectedAgent::subscribe()`, `publish()` (local-only) |
| 4 | Wire `NetworkedPubSub` into `ServingAgent` |
| 5 | Unit tests: subscribe/publish/local fan-out |

**Files**: `aafp-sdk/src/simple.rs`, `aafp-sdk/src/pubsub_bridge.rs` (new).

### Phase P2: Networked Propagation (Weeks 3-4)

**Goal**: Floodsub propagation across peers.

| Step | Deliverable |
|------|-------------|
| 1 | Propagation driver background task (§3.3) |
| 2 | `PubSubRpcHandler` dispatch arm in server handler loop |
| 3 | Client `subscribe()` sends `aafp.pubsub.subscribe` RPC |
| 4 | Client event listener (accept inbound publishes) |
| 5 | Integration test: 3-node floodsub, message reaches all |

**Files**: `aafp-sdk/src/simple.rs`, `aafp-sdk/src/pubsub_bridge.rs`.

### Phase P3: Back-Channeling (Weeks 5-6)

**Goal**: Progress events during long RPCs.

| Step | Deliverable |
|------|-------------|
| 1 | `EXT_BACKCHANNEL_TOPIC` extension (RFC-0006) |
| 2 | `Backchannel` type + `backchannel_handler()` |
| 3 | `call_with_backchannel()` client API |
| 4 | HITL approval round-trip test |
| 5 | Backward-compat test: server without ext support degrades gracefully |

**Files**: `aafp-messaging/src/extensions.rs`, `aafp-sdk/src/simple.rs`.

### Phase P4: Topic Routing & Security (Weeks 7-9)

**Goal**: Wildcards, hierarchies, ACLs.

| Step | Deliverable |
|------|-------------|
| 1 | Wildcard matching (`+`/`#`) in `NetworkedPubSub` |
| 2 | `TopicAcl` + `AclAuthorizationProvider` |
| 3 | `PubSubRpcHandler` ACL enforcement |
| 4 | Error code `9006 PUBSUB_UNAUTHORIZED` |
| 5 | Per-connection subscription limits |
| 6 | Conformance tests for wildcards + ACLs |

**Files**: `aafp-messaging/src/pubsub_v1.rs`, `aafp-core/src/authz.rs`, `aafp-sdk/src/simple.rs`.

### Phase P5: Webhook & Durable (Weeks 10-12, future)

**Goal**: HTTP bridge, relay-based durable subscriptions.

| Step | Deliverable |
|------|-------------|
| 1 | HTTP webhook bridge example |
| 2 | `.durable(via_relay=...)` subscription option |
| 3 | Relay buffering protocol (RFC-0010 extension) |
| 4 | Retained messages for status topics |

**Files**: `examples/webhook_bridge.rs`, `aafp-nat/src/relay_pubsub.rs` (new).

### Phase P6: Gossipsub (Future, RFC-0009 §4)

Replace floodsub propagation with mesh-based gossipsub. Wire format unchanged;
only the propagation driver (§3.3) and `remote_subscribers` selection logic
change. Add peer scoring and IHAVE/IWANT gossip.

---

## 10. New Error Codes (RFC-0005 extension)

| Code | Name | Description |
|------|------|-------------|
| 9006 | PUBSUB_UNAUTHORIZED | Caller lacks UCAN capability for topic/action |
| 9007 | PUBSUB_TOPIC_TOO_LONG | Topic exceeds max length |
| 9008 | PUBSUB_TOO_MANY_SUBS | Per-connection subscription limit exceeded |
| 9009 | PUBSUB_INVALID_TOPIC | Topic malformed (bad wildcard, bad hierarchy) |
| 9010 | PUBSUB_TTL_EXCEEDED | Message dropped due to TTL=0 (informational) |

---

## 11. Security Considerations

### 11.1 Unauthorized Publishing

Without ACLs (default), any authenticated peer can publish任意 topics, enabling
spam/DoS. Operators enforcing ACLs should grant publish narrowly. The propagation
driver validates `from` against the connection peer (RFC-0009 §5) so spoofing
requires a compromised key.

### 11.2 Floodsub Amplification

Floodsub forwards to *all* subscribers, creating amplification. TTL=3 bounds hop
count. For large networks, gossipsub (Phase P6) limits fan-out to a mesh.
Rate-limiting publishes per connection (§6.5) caps local amplification.

### 11.3 Back-Channel Spoofing

A malicious peer could publish to `rpc.<server>.<id>.progress` pretending to be
the server. Mitigations:
- Back-channel topics include an unguessable `req_id` (64+ random bits), so
  guessing is infeasible.
- ACLs (§6.4) restrict publish on `rpc.*` topics to the owning server.
- Clients verify `event.from()` equals the server's AgentId.

### 11.4 Subscription Leak

A peer that subscribes and disconnects ungracefully leaves stale entries.
RFC-0009 §5 cleans up on connection close; the SDK additionally runs a periodic
reconciliation that pings idle subscribed peers (reuse `keepalive` module) and
prunes unresponsive ones.

### 11.5 Resource Exhaustion

Inherited from `STREAMING_RPC_DESIGN.md` §13: `max_concurrent_streams`,
`stream_initial_max_data`, per-IP rate limiting, and the new per-connection
subscription limits (§6.5) bound memory. PubSub broadcast channels use a fixed
buffer (256 default); overflow drops laggy subscribers (broadcast semantics)
rather than blocking the publisher.

---

## 12. Performance Considerations

### 12.1 Fan-Out Cost

Floodsub fan-out is O(subscribers) per publish. For 100 subscribers on a single
node, a publish is 100 broadcast sends (cheap, in-process) + N remote RPC frames
over pooled connections. Remote sends are concurrent (`futures::join_all`).

### 12.2 Connection Reuse

PubSub reuses the `ConnectionPool` from `SESSION_AFFINITY_DESIGN.md`. Without
pooling, each publish to a remote peer would dial+handshake (~700µs each); with
pooling, it's a stream write (~14µs). The propagation driver must use pooled
connections — this is a hard dependency on Phase C1 of the roadmap.

### 12.3 Deduplication

`SeenCache` (60s TTL, 10K cap) is already O(1) amortized. For gossipsub, the
seen-cache moves to message-hash keys (content-addressed) rather than
`(topic, data, from)` tuples, reducing collisions.

### 12.4 Wildcard Matching

Wildcard matching is O(topic depth), typically <16 segments. With thousands of
wildcard subscriptions, a trie index (future optimization) reduces matching to
O(depth) total rather than O(subscriptions × depth).

---

## 13. Success Criteria

- [ ] `Agent::serve().topic("x").on_publish("x", h).start()` works end-to-end.
- [ ] `agent.subscribe("x").await?` yields events from a remote publisher.
- [ ] `agent.publish("x", Event::text("hi")).await?` reaches all subscribers on
      3 nodes within 50ms.
- [ ] `call_with_backchannel()` delivers progress events before the final
      response.
- [ ] Wildcard `agents.+.status` matches `agents.A.status` and `agents.B.status`.
- [ ] ACL enforcement rejects unauthorized publish with code 9006.
- [ ] Backward compat: existing unary RPC code unchanged; servers without
      back-channel ext still serve the RPC (no progress, but response works).
- [ ] No wire protocol changes (RFC-0002 Rev 6 compatible; RFC-0009 compatible).
- [ ] Conformance tests for floodsub propagation, dedup, TTL, wildcard, ACL.

---

## 14. Open Questions

1. **Uni-stream vs bi-stream for event delivery** (§7.2): v1 uses bi-stream
   (Option A) for RFC compliance; should v2 amend RFC-0009 to formalize
   uni-stream push?
2. **Retained messages**: should `agents.<id>.status` retain the latest value for
   late subscribers (MQTT-style)? Propose as RFC-0009 amendment.
3. **QoS levels**: floodsub is QoS 0. Is at-least-once (QoS 1) needed before
   gossipsub, or can gossipsub + acks provide it directly?
4. **Cross-network PubSub**: does PubSub propagate through circuit relays
   (RFC-0010), and does the relay broker subscriptions for NAT'd peers?
5. **Back-channel for client-streaming**: the design covers server-streaming +
   back-channel. Does client-streaming need a symmetric client->server
   back-channel? Likely yes for cancellation-ack and HITL responses.

---

## Appendix A: Full Server + Client Example

```rust
use aafp_sdk::simple::{Agent, Request, Response, Event};
use futures::stream::StreamExt;
use tokio_util::sync::CancellationToken;

// ── Server: long task with back-channel + PubSub ──────────────
#[tokio::main]
async fn main_server() -> Result<(), Box<dyn std::error::Error>> {
    Agent::serve()
        .capability("long.task")
        .topic("tasks.events")                       // publishes task events
        .on_publish("commands", |_t, ev| async move { // reacts to commands
            if ev.body() == "cancel-all" { /* ... */ }
        })
        .backchannel_handler(|req: Request, bc, cancel: CancellationToken| async move {
            for step in 0..=100 {
                if cancel.is_cancelled() { return Err("cancelled".into()); }
                bc.progress(step, format!("step {step}")).await;
                if step % 10 == 0 {
                    // also broadcast to a general topic
                    bc.publish_topic("tasks.events", Event::text(format!("task at {step}%"))).await;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            Ok(Response::text("done"))
        })
        .start().await?;
    Ok(())
}

// ── Client: call with back-channel + subscribe to topic ───────
#[tokio::main]
async fn main_client() -> Result<(), Box<dyn std::error::Error>> {
    let agent = Agent::connect().connect().await?;

    // Subscribe to the general task-events topic.
    let mut events = agent.subscribe("tasks.events").await?;
    let ev_task = tokio::spawn(async move {
        while let Some(ev) = events.next().await {
            println!("[topic] {}", ev.unwrap().body());
        }
    });

    // Call the long task with a back-channel for progress.
    let (resp_fut, mut progress) = agent
        .discover("long.task")
        .call_with_backchannel(Request::text("run"))
        .await?;

    let prog_task = tokio::spawn(async move {
        while let Some(p) = progress.next().await {
            println!("[progress] {}", p.unwrap().body());
        }
    });

    let result = resp_fut.await?;
    println!("result: {}", result.body());
    prog_task.await?;
    ev_task.await?;
    Ok(())
}
```

---

## Appendix B: Topic Matching Reference

```rust
/// MQTT-style topic filter matching.
///
/// `+` matches exactly one level. `#` matches zero or more remaining levels
/// and must be the last segment.
pub fn topic_matches(filter: &str, topic: &str) -> bool {
    let f: Vec<&str> = filter.split('/').collect();
    let t: Vec<&str> = topic.split('/').collect();
    let mut fi = 0;
    for seg in &t {
        match f.get(fi) {
            Some(&"#") => return true,
            Some(&"+") => fi += 1,
            Some(s) if *s == *seg => fi += 1,
            _ => return false,
        }
    }
    fi == f.len() || matches!(f.get(fi), Some(&"#"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn exact() { assert!(topic_matches("a/b/c", "a/b/c")); }
    #[test] fn single_wild() { assert!(topic_matches("a/+/c", "a/b/c")); }
    #[test] fn multi_wild() { assert!(topic_matches("a/#", "a/b/c/d")); }
    #[test] fn multi_wild_empty() { assert!(topic_matches("a/#", "a")); }
    #[test] fn no_match() { assert!(!topic_matches("a/b", "a/b/c")); }
}
```

---

## Appendix C: ACL Capability Encoding

A UCAN capability for PubSub is encoded as a CBOR text string:

```
"pubsub/<topic_filter>/<action>"
```

Examples:
- `"pubsub/tasks.*/subscribe"` — subscribe to any `tasks.*` topic
- `"pubsub/agents.A.inbox/publish"` — publish to A's inbox
- `"pubsub/rpc.A.#/publish"` — publish back-channel events for A's RPCs

The `TopicAcl::check` parses the capability, extracts the filter and action, and
reuses `topic_matches()` (Appendix B) for the filter. This keeps ACLs and
wildcard subscriptions on the same matching semantics, avoiding a second
pattern language.

---

This design exposes RFC-0009 PubSub and adds back-channeling to the Simple API
with no wire protocol changes, reusing the streaming RPC primitives from
`STREAMING_RPC_DESIGN.md` and the connection pooling from
`SESSION_AFFINITY_DESIGN.md`. The phased roadmap delivers local PubSub first,
networked propagation second, back-channeling third, and routing/security last —
each phase independently shippable and backward compatible.
