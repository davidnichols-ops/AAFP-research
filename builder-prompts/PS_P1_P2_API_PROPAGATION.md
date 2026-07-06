# Builder Prompt: PubSub Phase P1-P2 — Simple API Surface + Propagation Driver

**Target:** `aafp-sdk` (Rust high-level SDK) + `aafp-messaging` (PubSub wire layer)
**Phase:** P1 (Local PubSub Surface) + P2 (Networked Propagation)
**Estimated effort:** 2-4 weeks (P1: weeks 1-2, P2: weeks 3-4)
**Prerequisites:** Simple API v2 (`simple.rs`) with `ServeBuilder`, `ConnectedAgent`,
`ConnectionPool`, streaming RPC dispatch — all present in the current codebase.

---

## Objective

Expose RFC-0009 PubSub through the Simple API (`aafp-sdk/src/simple.rs`) and close
the open propagation loop in `aafp-messaging/src/pubsub_v1.rs`. After this work:

1. An agent can declare topics and react to publishes via `.topic()` / `.on_publish()`.
2. A connected client can `.subscribe()` to a topic and receive an async stream of
   `Event`s, and `.publish()` fire-and-forget events to a topic.
3. Published messages propagate across the network via floodsub: the propagation
   driver background task forwards `aafp.pubsub.publish` RPC frames to all remote
   subscribers tracked by `NetworkedPubSub`, decrementing TTL and maintaining the
   `seen` list for loop prevention.
4. The existing `PubSubRpcHandler` is wired into the `ServingAgent` handler dispatch
   alongside the `"call"` / capability arms, so inbound `aafp.pubsub.*` RPC requests
   are handled correctly.

**No wire protocol changes.** Everything reuses RFC-0009 RPC methods, RFC-0002
frames, and the existing `ConnectionPool`.

The deliverable: `Agent::serve().topic("x").on_publish("x", h).start()` works
end-to-end; `agent.subscribe("x").await?` yields events from a remote publisher
within 50ms on a 3-node setup.

---

## Source Material

Read these documents before implementing:

1. **`PUBSUB_BACKCHANNEL_DESIGN.md`** §1.2 (existing implementation analysis),
   §3.1 (server-side `.topic()` / `.on_publish()`), §3.2 (client-side
   `.subscribe()` / `.publish()`), §3.3 (propagation driver), §3.4 (`Event` type),
   §7.2 (QUIC stream mapping — Option A bi-stream per publish), §9 (P1/P2 roadmap).
2. **`RFCs/0009-pubsub.md`** §2 (wire format: subscribe/unsubscribe/publish CBOR),
   §3 (floodsub: subscription tracking, propagation, dedup, TTL), §5 (security:
   `from` verified against connection peer, per-connection cleanup).
3. **`implementations/rust/crates/aafp-messaging/src/pubsub_v1.rs`** — the existing
   793-line `NetworkedPubSub` + `PubSubRpcHandler` implementation. Understand what
   already exists (encode/decode, seen-cache, remote subscriber tracking) and what
   is missing (propagation driver, Simple API integration).
4. **`implementations/rust/crates/aafp-sdk/src/simple.rs`** — the 1963-line Simple
   API. Understand `ServeBuilder`, `ServingAgent` handler loop (lines 630-856),
   `ConnectedAgent`, `ConnectionPool` usage, and the `call_agent_with_pool` /
   `call_streaming_with_pool` helpers.
5. **`implementations/rust/crates/aafp-sdk/src/connection_pool.rs`** —
   `ConnectionPool::get_or_connect()` (line 176) and `release()` (line 271), used
   by the propagation driver to send publish RPC frames to remote peers.

---

## Background: What Already Exists

### `pubsub_v1.rs` (complete wire layer, missing propagation)

The `NetworkedPubSub` struct already provides:

- **Local subscriptions**: `HashMap<Topic, broadcast::Sender<TopicMessage>>` with
  `subscribe()` → `broadcast::Receiver<TopicMessage>`, `publish_local()` (line 322).
- **Remote subscriber tracking**: `Arc<Mutex<HashMap<Topic, HashSet<AgentId>>>>`
  with `add_remote_subscriber()` (line 378), `remove_remote_subscriber()` (line 384),
  `remove_peer()` (line 395), `remote_subscribers()` (line 418).
- **CBOR encode/decode**: `SubscribeParams`, `UnsubscribeParams`, `PublishParams`
  with `to_cbor()` / `from_cbor()` / `encode()` per RFC-0009 §2.
- **Seen-cache**: `SeenCache` (60s TTL, 10K cap, LRU eviction) with
  `check_and_mark()` for dedup.
- **Remote message handling**: `handle_remote_message()` (line 345) — checks
  seen-cache, delivers to local subscribers, returns whether to re-forward (TTL > 0).
- **Publish request encoding**: `encode_publish_request()` (line 458) — produces
  CBOR bytes for an `aafp.pubsub.publish` RPC frame payload.
- **RPC handler**: `PubSubRpcHandler` (line 478) with `handle_request()` dispatching
  `METHOD_SUBSCRIBE` / `METHOD_UNSUBSCRIBE` / `METHOD_PUBLISH`.

### The open propagation loop (THE BUG to fix)

`encode_publish_request()` and `remote_subscribers()` **exist but are never called
by the SDK**. `publish_local()` only delivers to local broadcast channels — it does
not propagate to remote peers. `PubSubRpcHandler::handle_publish()` calls
`handle_remote_message()` which delivers locally and returns `Ok(should_reforward)`,
but **nothing acts on the `should_reforward` result** — the message dies at the
receiving node. There is no background task that forwards published messages to
remote subscribers. This means PubSub is currently local-only despite having all
the wire machinery.

### `simple.rs` (no PubSub integration)

The `ServingAgent` handler loop (lines 664-831) only dispatches the RPC `method`
as a capability name against `capability_handlers` / `streaming_handlers` /
`fallback_handler`. There is no dispatch arm for `aafp.pubsub.*` methods. The
`ServeBuilder` has no `.topic()` or `.on_publish()` methods. The `ConnectedAgent`
has no `.subscribe()` or `.publish()` methods. There is no `Event` type.

### Exports

`aafp-messaging/src/lib.rs` (line 43) already re-exports:
`NetworkedPubSub`, `PubSubRpcHandler`, `PublishParams`, `SubscribeParams`,
`UnsubscribeParams`, `DEFAULT_TTL`, `METHOD_PUBLISH`, `METHOD_SUBSCRIBE`,
`METHOD_UNSUBSCRIBE`. The SDK crate depends on `aafp-messaging`, so these are
available via `aafp_messaging::`.

---

## Files to Create / Modify

| File | Action | Purpose |
|------|--------|---------|
| `aafp-sdk/src/simple.rs` | **Modify** | Add `Event` type, `SubscriptionStream`, `ServeBuilder::topic()` / `on_publish()`, `ConnectedAgent::subscribe()` / `publish()`, wire `PubSubRpcHandler` into handler dispatch, spawn propagation driver |
| `aafp-sdk/src/pubsub_bridge.rs` | **Create** | Bridge module: `PubSubBridge` wrapping `Arc<NetworkedPubSub>`, propagation driver task, `send_publish_rpc()` helper, local-publish event channel |
| `aafp-sdk/src/lib.rs` | **Modify** | `mod pubsub_bridge;` and re-export `Event`, `SubscriptionStream` |
| `aafp-messaging/src/pubsub_v1.rs` | **Modify** | Add `local_publish_events()` mpsc channel for propagation driver; add `seen_for()` helper; make `NetworkedPubSub` fields `pub(crate)` or add accessors as needed |
| `aafp-sdk/tests/pubsub_test.rs` | **Create** | Integration tests: local subscribe/publish, multi-subscriber fan-out, 3-node floodsub propagation, dedup, TTL |

---

## Implementation Tasks

### Task 1: `Event` Type (`simple.rs`)

Add the `Event` type that mirrors `Request`/`Response` ergonomics and wraps
`TopicMessage` from `pubsub_v1.rs`. It carries the topic, publisher AgentId,
timestamp, and payload (text or binary).

```rust
use std::time::SystemTime;

/// A PubSub event delivered to a subscriber.
///
/// Wraps `aafp_messaging::TopicMessage` with ergonomic accessors matching
/// the `Request`/`Response` pattern. Carries the topic name, the publisher's
/// AgentId, a timestamp, and the payload (text or binary).
#[derive(Debug, Clone)]
pub struct Event {
    /// The topic this event was published to.
    topic: String,
    /// The AgentId of the publisher.
    from: AgentId,
    /// Unix timestamp (seconds) when the event was created/published.
    timestamp: u64,
    /// Optional text body (human-readable events).
    text: String,
    /// Optional binary payload (structured CBOR, raw bytes).
    data: Option<Vec<u8>>,
}

impl Event {
    /// Create a text event (v1 compat, like `Request::text`).
    pub fn text(s: impl Into<String>) -> Self {
        Self {
            topic: String::new(),
            from: [0u8; 32],
            timestamp: SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
            text: s.into(),
            data: None,
        }
    }

    /// Create a binary data event.
    pub fn data(d: Vec<u8>) -> Self {
        Self {
            topic: String::new(),
            from: [0u8; 32],
            timestamp: SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
            text: String::new(),
            data: Some(d),
        }
    }

    /// Set the topic (used internally when constructing from a TopicMessage).
    pub fn with_topic(mut self, topic: impl Into<String>) -> Self {
        self.topic = topic.into();
        self
    }

    /// Set the publisher AgentId (used internally).
    pub fn with_from(mut self, from: AgentId) -> Self {
        self.from = from;
        self
    }

    /// Get the topic this event was published to.
    pub fn topic(&self) -> &str {
        &self.topic
    }

    /// Get the publisher's AgentId.
    pub fn from(&self) -> AgentId {
        self.from
    }

    /// Get the Unix timestamp (seconds).
    pub fn timestamp(&self) -> u64 {
        self.timestamp
    }

    /// Get the text body (v1 compat).
    pub fn body(&self) -> &str {
        &self.text
    }

    /// Get the binary payload, if any.
    pub fn payload(&self) -> Option<&[u8]> {
        self.data.as_deref()
    }

    /// Encode the event to bytes for publishing (prefers text, falls back to data).
    pub fn encode_payload(&self) -> Vec<u8> {
        if let Some(data) = &self.data {
            data.clone()
        } else {
            self.text.as_bytes().to_vec()
        }
    }

    /// Decode an event from a `TopicMessage` (received from the wire or locally).
    pub fn from_topic_message(msg: &aafp_messaging::TopicMessage) -> Self {
        // Heuristic: try to interpret as UTF-8 text; if it fails, treat as binary.
        let text = String::from_utf8(msg.data.clone()).unwrap_or_default();
        let data = if String::from_utf8(msg.data.clone()).is_ok() {
            None
        } else {
            Some(msg.data.clone())
        };
        Self {
            topic: msg.topic.clone(),
            from: msg.from,
            timestamp: SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
            text,
            data,
        }
    }
}
```

**Design note**: `Event::text()` and `Event::data()` mirror `Request::text()` and
`Request::data()`. The `from_topic_message()` constructor handles the wire decode
side. The text/binary heuristic matches how `simple.rs` currently decodes RPC
params (line 710-720: `TextString` vs `ByteString`). For P1/P2 this heuristic is
sufficient; structured CBOR payloads are a future extension (design doc §4.2).

---

### Task 2: `SubscriptionStream` (`simple.rs`)

The client-side handle for a topic subscription. Wraps a `tokio::sync::mpsc::Receiver`
that is fed by the event listener task. Implements async stream semantics matching
`ResponseStream` (line 476).

```rust
/// A stream of PubSub events for a topic subscription.
///
/// Created by `ConnectedAgent::subscribe()`. Call `.next().await` to receive
/// each `Event`. The stream closes when the subscription is dropped or the
/// connection is lost.
///
/// Mirrors `ResponseStream` (line 476) but yields `Event` instead of `Response`.
pub struct SubscriptionStream {
    inner: mpsc::Receiver<Result<Event, SdkError>>,
}

impl SubscriptionStream {
    /// Receive the next event from the subscription.
    ///
    /// Returns `None` when the subscription is closed (connection lost or
    /// unsubscribed). Returns `Some(Err(...))` on a decode/transport error.
    pub async fn next(&mut self) -> Option<Result<Event, SdkError>> {
        self.inner.recv().await
    }
}
```

**Design note**: Using `mpsc::Receiver` (not `broadcast::Receiver`) for the
client-facing stream because each subscription has exactly one consumer. The
internal `NetworkedPubSub` uses `broadcast` for fan-out to multiple local
subscribers; the bridge converts `broadcast::Receiver<TopicMessage>` →
`mpsc::Sender<Result<Event, SdkError>>` via a spawned forwarder task.

---

### Task 3: `ServeBuilder` Additions — `.topic()` and `.on_publish()` (`simple.rs`)

#### 3.1 New fields on `ServeBuilder`

Add fields to track PubSub configuration (line 518):

```rust
pub struct ServeBuilder {
    capabilities: Vec<String>,
    capability_handlers: HashMap<String, CapabilityHandler>,
    streaming_handlers: HashMap<String, StreamingHandler>,
    fallback_handler: Option<HandlerFnV2>,
    bind_addr: Option<SocketAddr>,
    keypair: Option<AgentKeypair>,
    metrics_addr: Option<SocketAddr>,
    // ── PubSub (P1/P2) ──
    /// Topics this agent publishes to (registered on start).
    pubsub_topics: Vec<String>,
    /// on_publish handlers: topic → async handler closure.
    pubsub_on_publish: Vec<(String, OnPublishHandler)>,
}
```

#### 3.2 `OnPublishHandler` type alias

```rust
/// Handler invoked when a PubSub event is received on a subscribed topic.
///
/// Sugar for `subscribe()` + a spawned consumer task. The handler receives
/// the topic name and the decoded `Event`.
pub type OnPublishHandler = Arc<
    dyn Fn(&str, Event) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync,
>;
```

#### 3.3 `.topic()` method

Registers a topic the agent may publish to. The builder wires a
`NetworkedPubSub` instance into the serving agent and ensures the topic's
broadcast channel exists.

```rust
impl ServeBuilder {
    /// Declare a PubSub topic this agent publishes to.
    ///
    /// Registers the topic in the internal `NetworkedPubSub` so that
    /// `publish()` calls succeed. The topic is also advertised so remote
    /// peers can subscribe to it. Multiple `.topic()` calls register
    /// multiple topics.
    ///
    /// # Example
    /// ```no_run
    /// # use aafp_sdk::simple::Agent;
    /// # async fn run() -> Result<(), Box<dyn std::error::Error>> {
    /// Agent::serve()
    ///     .capability("translate")
    ///     .topic("translate.events")
    ///     .start()
    ///     .await?;
    /// # Ok(())
    /// # }
    /// ```
    pub fn topic(mut self, name: impl Into<String>) -> Self {
        let name = name.into();
        if !self.pubsub_topics.contains(&name) {
            self.pubsub_topics.push(name);
        }
        self
    }
}
```

#### 3.4 `.on_publish()` method

Subscribe locally to a topic and invoke `handler` for each event. This is sugar
for `subscribe()` + a spawned consumer task.

```rust
impl ServeBuilder {
    /// Subscribe to a PubSub topic and invoke `handler` for each event.
    ///
    /// This is sugar for `subscribe()` + a spawned consumer task. The handler
    /// runs in a background task for the lifetime of the `ServingAgent`.
    /// Multiple `.on_publish()` calls register handlers for different topics.
    ///
    /// # Example
    /// ```no_run
    /// # use aafp_sdk::simple::{Agent, Event};
    /// # async fn run() -> Result<(), Box<dyn std::error::Error>> {
    /// Agent::serve()
    ///     .on_publish("commands", |_topic, ev: Event| async move {
    ///         if ev.body() == "shutdown" {
    ///             // react to a published command
    ///         }
    ///     })
    ///     .start()
    ///     .await?;
    /// # Ok(())
    /// # }
    /// ```
    pub fn on_publish<F, Fut>(mut self, topic: impl Into<String>, f: F) -> Self
    where
        F: Fn(&str, Event) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let topic = topic.into();
        let handler: OnPublishHandler = Arc::new(move |t: &str, ev: Event| {
            let f = f;
            Box::pin(f(t, ev))
        });
        self.pubsub_on_publish.push((topic, handler));
        self
    }
}
```

#### 3.5 Wire `NetworkedPubSub` into `ServingAgent::start()`

In `start()` (line 610), after building the `SdkAgent`, create a
`NetworkedPubSub` and `PubSubBridge` if any PubSub config is present:

```rust
// In ServeBuilder::start(), after `let agent = Arc::new(builder.build().await?);`
// (line 620) and before the accept loop spawn (line 631):

let has_pubsub = !self.pubsub_topics.is_empty() || !self.pubsub_on_publish.is_empty();

let pubsub_bridge = if has_pubsub {
    let pubsub = Arc::new(NetworkedPubSub::new(agent_id));
    // Pre-register topics (create broadcast channels)
    for topic in &self.pubsub_topics {
        let _rx = pubsub.subscribe(topic); // creates the broadcast channel
    }
    // Set up on_publish handlers: subscribe + spawn consumer tasks
    let on_publish_handlers = self.pubsub_on_publish.clone();
    let bridge = Arc::new(crate::pubsub_bridge::PubSubBridge::new(
        Arc::clone(&pubsub),
        agent_id,
    ));
    // Spawn on_publish consumer tasks
    for (topic, handler) in on_publish_handlers {
        let mut rx = pubsub.subscribe(&topic);
        let handler = handler.clone();
        let topic_clone = topic.clone();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(msg) => {
                        let event = Event::from_topic_message(&msg);
                        handler(&topic_clone, event).await;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!("pubsub on_publish lagged by {n} messages");
                        continue;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }
    Some(bridge)
} else {
    None
};
```

Then in the per-connection handler spawn (line 647), clone `pubsub_bridge` into
the task and use it for RPC dispatch. The `PubSubRpcHandler` must be created
once (shared across connections) and used in the dispatch arm.

---

### Task 4: Wire `PubSubRpcHandler` into Handler Dispatch (`simple.rs`)

The existing handler loop (lines 700-830) decodes an `RpcRequest` and uses
`rpc_req.method` as the capability name. We need to intercept `aafp.pubsub.*`
methods **before** the capability lookup and dispatch them to
`PubSubRpcHandler::handle_request()`.

Insert the dispatch arm after decoding the RPC request (line 704) and before
the capability lookup (line 730):

```rust
// After: let rpc_req = match RpcRequest::decode(&frame.payload) { ... };
// (line 704)

// ── PubSub RPC dispatch (P1/P2) ──
// Intercept aafp.pubsub.* methods and dispatch to PubSubRpcHandler.
// The caller_id is the verified peer AgentId from the session.
if rpc_req.method.starts_with("aafp.pubsub.") {
    let pubsub_bridge = match &pubsub_bridge {
        Some(b) => b.clone(),
        None => {
            // No PubSub configured — return method-not-found error
            let rpc_resp = RpcResponse::error(
                rpc_req.id,
                RpcErrorObject::new(
                    aafp_core::error::codes::UNSUPPORTED_CAPABILITY,
                    "pubsub not enabled on this agent",
                ),
            );
            let resp_bytes = match rpc_resp.encode() {
                Ok(bytes) => bytes,
                Err(_) => return,
            };
            let resp_frame = Frame::data(0, resp_bytes);
            let resp_frame_bytes = match encode_frame(&resp_frame) {
                Ok(bytes) => bytes,
                Err(_) => return,
            };
            let _ = send.write_all(&resp_frame_bytes).await;
            send.finish();
            return;
        }
    };

    // The peer's AgentId — verified during handshake. For PubSub, this is
    // the `from` field (RFC-0009 §5: verified against connection peer).
    let caller_id = peer_id; // from the session, passed into this closure

    // Dispatch to PubSubRpcHandler
    let result = pubsub_bridge.rpc_handler().handle_request(
        &rpc_req.method,
        &rpc_req.params,
        &caller_id,
    );

    let rpc_resp = match result {
        Ok(value) => RpcResponse::success(rpc_req.id, value),
        Err(e) => RpcResponse::error(
            rpc_req.id,
            RpcErrorObject::new(9000, e.to_string()),
        ),
    };

    let resp_bytes = match rpc_resp.encode() {
        Ok(bytes) => bytes,
        Err(_) => return,
    };
    let resp_frame = Frame::data(0, resp_bytes);
    let resp_frame_bytes = match encode_frame(&resp_frame) {
        Ok(bytes) => bytes,
        Err(_) => return,
    };
    let _ = send.write_all(&resp_frame_bytes).await;
    send.finish();
    return;
}

// ── Existing capability dispatch continues below (line 706+) ──
```

**Important**: The `peer_id` (caller's AgentId) must be available in the
per-connection task. Currently the session is established at line 649 but the
peer's AgentId is not captured into a variable. You need to extract it from the
session/peer_info returned by `establish_session()` (line 649-653) and pass it
into the per-bi-stream task. The `establish_session` returns `(session, conn,
peer_info)` — use `peer_info.agent_id` as `caller_id`.

**Re-forwarding on publish**: When `handle_publish()` calls
`handle_remote_message()` and it returns `Ok(true)` (should re-forward), the
propagation driver must pick up the message. The simplest approach: the
`PubSubBridge` installs a broadcast listener on the `NetworkedPubSub`'s local
channels that, upon receiving a forwarded message, calls
`encode_publish_request()` and sends it to `remote_subscribers()`. See Task 6
for the propagation driver design.

---

### Task 5: `ConnectedAgent` Additions — `.subscribe()` and `.publish()` (`simple.rs`)

#### 5.1 `.subscribe()`

Subscribes to a topic on a remote agent and returns a `SubscriptionStream`.
Under the hood (per design doc §3.2 and §7.2 Option A):

1. Sends an `aafp.pubsub.subscribe` RPC request on a bi-stream to the remote
   peer (using `ConnectionPool::get_or_connect()`).
2. Spawns a listener task that accepts inbound `aafp.pubsub.publish` RPC requests
   on **server-initiated bi-streams** (the server dials back on the same
   connection) OR — more simply for v1 — the client keeps a long-lived bi-stream
   open and the server sends publish frames as RPC requests on it.
3. Decodes each `PublishParams` into an `Event` and pushes it to an
   `mpsc::Receiver` backing the `SubscriptionStream`.

```rust
impl ConnectedAgent {
    /// Subscribe to a PubSub topic on a remote agent.
    ///
    /// Sends an `aafp.pubsub.subscribe` RPC request and returns a
    /// `SubscriptionStream` that yields `Event`s as they are published.
    ///
    /// For v1 (Option A, design doc §7.2), the client opens a bi-stream,
    /// sends the subscribe request, and keeps the stream open. The server
    /// forwards published messages as `aafp.pubsub.publish` RPC requests
    /// on server-initiated bi-streams back to the client. The client's
    /// event listener task accepts these bi-streams, decodes the
    /// `PublishParams`, and pushes `Event`s to the returned stream.
    ///
    /// # Example
    /// ```no_run
    /// # use aafp_sdk::simple::{Agent, Event};
    /// # use futures::stream::StreamExt;
    /// # async fn run() -> Result<(), Box<dyn std::error::Error>> {
    /// let agent = Agent::connect().connect().await?;
    /// let mut events = agent.subscribe("translate.events").await?;
    /// while let Some(event) = events.next().await {
    ///     println!("event: {}", event?.body());
    /// }
    /// # Ok(())
    /// # }
    /// ```
    pub async fn subscribe(&self, topic: &str) -> Result<SubscriptionStream, SdkError> {
        // For local-only P1: subscribe to the local NetworkedPubSub if present.
        // For P2 networked: send subscribe RPC to the remote peer.
        //
        // P1 implementation (local-only, no remote peer):
        // The ConnectedAgent holds an optional Arc<NetworkedPubSub> for
        // local subscriptions. subscribe() creates a broadcast receiver
        // and spawns a forwarder to an mpsc channel.
        //
        // P2 implementation (networked):
        // 1. Use pool.get_or_connect() to get a connection to the peer.
        // 2. Encode SubscribeParams, send as RPC request on a bi-stream.
        // 3. Spawn an event listener that accepts inbound bi-streams
        //    (conn.accept_bi() in a loop), decodes PublishParams from
        //    each, and pushes Events to the mpsc channel.
        // 4. Return SubscriptionStream backed by the mpsc::Receiver.

        let (tx, rx) = mpsc::channel::<Result<Event, SdkError>>(256);

        // P2: send subscribe RPC to remote peer
        // (requires knowing the peer's address — use discover or a direct addr)
        // For now, if the ConnectedAgent has a local pubsub (P1), use it:
        if let Some(pubsub) = &self.local_pubsub {
            let mut bcast_rx = pubsub.write().await.subscribe(topic);
            tokio::spawn(async move {
                loop {
                    match bcast_rx.recv().await {
                        Ok(msg) => {
                            let event = Event::from_topic_message(&msg);
                            if tx.send(Ok(event)).await.is_err() {
                                break; // consumer dropped
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            tracing::warn!("subscription lagged by {n}");
                            continue;
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            let _ = tx.send(Err(SdkError::Messaging(
                                "subscription closed".to_string(),
                            ))).await;
                            break;
                        }
                    }
                }
            });
            return Ok(SubscriptionStream { inner: rx });
        }

        // P2 networked path: send subscribe RPC
        // (implemented when propagation driver is in place)
        Err(SdkError::Messaging(
            "subscribe requires a connected peer or local pubsub".to_string(),
        ))
    }
}
```

**Note for implementer**: The `ConnectedAgent` needs a way to know which peer
to subscribe with. Options: (a) `subscribe_to(addr, topic)` for explicit peer,
(b) auto-discover a peer that hosts the topic. For P2, add a `subscribe_to()`
variant that takes an explicit address, and have `subscribe()` use the first
pooled connection or a discovered peer. The design doc §3.2 shows
`agent.subscribe("translate.events")` without an address — this implies the SDK
either discovers a topic-hosting peer or subscribes on all pooled connections.
For P1/P2, implement `subscribe_to(addr, topic)` first, then add `subscribe(topic)`
as a convenience that uses the first available pooled peer.

#### 5.2 `.publish()`

Publishes an event to a topic. Sends an `aafp.pubsub.publish` RPC request to the
remote peer (or publishes locally if no peer is specified).

```rust
impl ConnectedAgent {
    /// Publish an event to a PubSub topic (fire-and-forget).
    ///
    /// Sends an `aafp.pubsub.publish` RPC request to the remote peer.
    /// The peer's propagation driver forwards the message to all remote
    /// subscribers (floodsub, RFC-0009 §3.2).
    ///
    /// # Example
    /// ```no_run
    /// # use aafp_sdk::simple::{Agent, Event};
    /// # async fn run() -> Result<(), Box<dyn std::error::Error>> {
    /// let agent = Agent::connect().connect().await?;
    /// agent.publish("commands", Event::text("shutdown")).await?;
    /// # Ok(())
    /// # }
    /// ```
    pub async fn publish(
        &self,
        topic: &str,
        event: Event,
    ) -> Result<(), SdkError> {
        self.publish_to(topic, event, None).await
    }

    /// Publish to a topic on a specific peer (by address).
    ///
    /// If `addr` is None, publishes locally (P1) or to the first pooled peer.
    pub async fn publish_to(
        &self,
        topic: &str,
        event: Event,
        addr: Option<&str>,
    ) -> Result<(), SdkError> {
        let data = event.encode_payload();

        // P1 local-only: publish to local NetworkedPubSub if present
        if addr.is_none() {
            if let Some(pubsub) = &self.local_pubsub {
                let from = *self.agent.id();
                pubsub.write().await
                    .publish_local(topic, from, data)
                    .map_err(|e| SdkError::Messaging(e.to_string()))?;
                return Ok(());
            }
        }

        // P2 networked: send publish RPC to remote peer
        let addr = addr.ok_or_else(|| SdkError::Messaging(
            "publish requires an address or local pubsub".to_string(),
        ))?;

        let (peer_id, conn) = self.pool.get_or_connect(&self.agent, addr).await?;

        // Encode publish params
        let params = PublishParams::new(topic, data);
        let rpc_bytes = params.encode()
            .map_err(|e| SdkError::Messaging(e.to_string()))?;

        // Send as RPC request
        let rpc_req = RpcRequest::new(1, METHOD_PUBLISH).with_params(
            aafp_cbor::Value::IntMap(params.to_cbor().as_int_map().cloned().unwrap_or_default())
        );
        // Alternatively, encode PublishParams directly as the RPC params value.
        // The PubSubRpcHandler expects params as a CBOR value, so we pass
        // PublishParams::to_cbor() as the RPC params.

        let rpc_req = RpcRequest::new(1, METHOD_PUBLISH)
            .with_params(params.to_cbor());
        let rpc_bytes = rpc_req.encode()
            .map_err(|e| SdkError::Messaging(e.to_string()))?;

        let (mut send, mut recv) = conn.open_bi().await?;
        let frame = Frame::data(0, rpc_bytes);
        let frame_bytes = encode_frame(&frame)?;
        send.write_all(&frame_bytes).await?;
        send.finish();

        // Read response (empty map {} on success)
        let mut header = [0u8; FRAME_HEADER_SIZE];
        recv.read_exact(&mut header).await?;
        let payload_len = u64::from_be_bytes(header[12..20].try_into().unwrap()) as usize;
        let ext_len = u64::from_be_bytes(header[20..28].try_into().unwrap()) as usize;
        let body_len = payload_len + ext_len;
        if body_len > 0 {
            let mut body = vec![0u8; body_len];
            recv.read_exact(&mut body).await?;
        }

        self.pool.release(&peer_id).await;
        Ok(())
    }
}
```

**Important**: The `RpcRequest::with_params()` takes a `Value`. The
`PubSubRpcHandler::handle_request()` receives `params: &Value` and calls
`SubscribeParams::from_cbor(params)` / `PublishParams::from_cbor(params)`. So
the RPC params must be the CBOR map from `to_cbor()`, not wrapped in an
additional layer. Verify that `RpcRequest::with_params(PublishParams::to_cbor())`
produces the right wire format — the existing `call_agent_with_pool` (line 1402)
passes `Value::TextString` / `Value::IntMap` directly as params, so this is
consistent.

---

### Task 6: Propagation Driver (`pubsub_bridge.rs`)

This is the core P2 deliverable: a background task that closes the open
propagation loop. After a local publish (or a forwarded remote publish), it
queries `remote_subscribers(topic)`, computes the `seen` list, decrements TTL,
and sends `aafp.pubsub.publish` RPC frames to each peer.

#### 6.1 `PubSubBridge` struct

```rust
// aafp-sdk/src/pubsub_bridge.rs

use aafp_messaging::{
    NetworkedPubSub, PubSubRpcHandler, PublishParams, TopicMessage,
    DEFAULT_TTL, METHOD_PUBLISH,
};
use aafp_identity::AgentId;
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc};

/// Bridge between the Simple API and the `NetworkedPubSub` wire layer.
///
/// Wraps an `Arc<NetworkedPubSub>` and runs the propagation driver
/// background task that forwards published messages to remote subscribers
/// (floodsub, RFC-0009 §3.2).
///
/// Created by `ServeBuilder::start()` when PubSub is configured.
pub struct PubSubBridge {
    pubsub: Arc<NetworkedPubSub>,
    rpc_handler: Arc<PubSubRpcHandler>,
    our_id: AgentId,
    /// Channel for local publish events (triggers propagation).
    publish_events_tx: mpsc::UnboundedSender<(String, AgentId, Vec<u8>)>,
}

impl PubSubBridge {
    /// Create a new bridge wrapping the given PubSub instance.
    pub fn new(pubsub: Arc<NetworkedPubSub>, our_id: AgentId) -> Self {
        let rpc_handler = Arc::new(PubSubRpcHandler::new(Arc::clone(&pubsub)));
        let (publish_events_tx, publish_events_rx) = mpsc::unbounded_channel();
        let bridge = Self {
            pubsub,
            rpc_handler,
            our_id,
            publish_events_tx,
        };
        // Spawn the propagation driver (P2)
        bridge.spawn_propagation_driver(publish_events_rx);
        bridge
    }

    /// Get the RPC handler for dispatching aafp.pubsub.* requests.
    pub fn rpc_handler(&self) -> &PubSubRpcHandler {
        &self.rpc_handler
    }

    /// Get the underlying NetworkedPubSub (for local subscribe/publish).
    pub fn pubsub(&self) -> &Arc<NetworkedPubSub> {
        &self.pubsub
    }

    /// Notify the propagation driver of a local publish.
    /// Called when the agent publishes locally (via publish_local or
    /// when a remote message is received and should be re-forwarded).
    pub fn notify_local_publish(
        &self,
        topic: String,
        from: AgentId,
        data: Vec<u8>,
    ) {
        let _ = self.publish_events_tx.send((topic, from, data));
    }

    /// Spawn the propagation driver background task.
    ///
    /// This closes the open loop in pubsub_v1.rs: after a local publish,
    /// it queries remote_subscribers(topic), computes the seen list,
    /// decrements TTL, and sends aafp.pubsub.publish RPC frames to each
    /// peer over pooled connections.
    fn spawn_propagation_driver(
        &self,
        mut rx: mpsc::UnboundedReceiver<(String, AgentId, Vec<u8>)>,
    ) {
        let pubsub = Arc::clone(&self.pubsub);
        let our_id = self.our_id;

        tokio::spawn(async move {
            while let Some((topic, from, data)) = rx.recv().await {
                // Get remote peers subscribed to this topic
                let peers = pubsub.remote_subscribers(&topic);
                if peers.is_empty() {
                    continue;
                }

                // Compute seen list: includes our_id and the original sender
                let mut seen: Vec<AgentId> = vec![our_id, from];

                // Decrement TTL for forwarding
                let ttl = DEFAULT_TTL.saturating_sub(1);

                // Forward to each remote peer (skip those already in seen)
                for peer in &peers {
                    if seen.contains(peer) {
                        continue;
                    }
                    seen.push(*peer);

                    // Encode the publish request for this peer
                    let payload = match pubsub.encode_publish_request(
                        &topic,
                        data.clone(),
                        ttl,
                        seen.clone(),
                    ) {
                        Ok(bytes) => bytes,
                        Err(e) => {
                            tracing::warn!("pubsub encode error: {e}");
                            continue;
                        }
                    };

                    // Send the publish RPC to the peer.
                    // This requires a connection to the peer. In P2, we use
                    // the ConnectionPool. However, the propagation driver
                    // does not have direct access to the pool (it's in the
                    // ServingAgent). The bridge must be given a reference
                    // to the pool, or the send is done via a callback.
                    //
                    // For P2, the bridge holds an Arc<ConnectionPool> and
                    // the agent's Arc<SdkAgent> for dialing. See Task 6.2.
                    //
                    // Placeholder: log until pool integration is wired.
                    tracing::debug!(
                        "would forward pubsub to peer {:?} on topic '{}'",
                        peer, topic
                    );
                }
            }
        });
    }
}
```

#### 6.2 Pool integration for the propagation driver

The propagation driver needs to send RPC frames to remote peers. It needs
access to the `ConnectionPool` and `SdkAgent` (for dialing new peers). Update
`PubSubBridge::new()` to accept these:

```rust
use crate::connection_pool::ConnectionPool;
use crate::Agent as SdkAgent;
use aafp_messaging::{encode_frame, Frame, RpcRequest};

impl PubSubBridge {
    /// Create with pool access for networked propagation (P2).
    pub fn new_with_pool(
        pubsub: Arc<NetworkedPubSub>,
        our_id: AgentId,
        agent: Arc<SdkAgent>,
        pool: Arc<ConnectionPool>,
    ) -> Self {
        let rpc_handler = Arc::new(PubSubRpcHandler::new(Arc::clone(&pubsub)));
        let (publish_events_tx, publish_events_rx) = mpsc::unbounded_channel();
        let bridge = Self {
            pubsub,
            rpc_handler,
            our_id,
            publish_events_tx,
        };
        bridge.spawn_propagation_driver_with_pool(
            publish_events_rx,
            agent,
            pool,
        );
        bridge
    }

    fn spawn_propagation_driver_with_pool(
        &self,
        mut rx: mpsc::UnboundedReceiver<(String, AgentId, Vec<u8>)>,
        agent: Arc<SdkAgent>,
        pool: Arc<ConnectionPool>,
    ) {
        let pubsub = Arc::clone(&self.pubsub);
        let our_id = self.our_id;

        tokio::spawn(async move {
            while let Some((topic, from, data)) = rx.recv().await {
                let peers = pubsub.remote_subscribers(&topic);
                if peers.is_empty() {
                    continue;
                }

                let mut seen: Vec<AgentId> = vec![our_id, from];
                let ttl = DEFAULT_TTL.saturating_sub(1);

                for peer in &peers {
                    if seen.contains(peer) {
                        continue;
                    }
                    seen.push(*peer);

                    // Look up the peer's address from the DHT
                    let peer_addr = find_peer_addr(&agent, peer);
                    let peer_addr = match peer_addr {
                        Some(a) => a,
                        None => {
                            tracing::warn!(
                                "pubsub: no address for peer {:?}, skipping",
                                peer
                            );
                            continue;
                        }
                    };

                    let payload = match pubsub.encode_publish_request(
                        &topic,
                        data.clone(),
                        ttl,
                        seen.clone(),
                    ) {
                        Ok(bytes) => bytes,
                        Err(e) => {
                            tracing::warn!("pubsub encode error: {e}");
                            continue;
                        }
                    };

                    // Send publish RPC to the peer via the connection pool
                    let send_result = send_publish_rpc(
                        &agent,
                        &pool,
                        &peer_addr,
                        payload,
                    ).await;

                    if let Err(e) = send_result {
                        tracing::warn!(
                            "pubsub forward to {} failed: {e}",
                            peer_addr
                        );
                    }
                }
            }
        });
    }
}

/// Send an aafp.pubsub.publish RPC frame to a peer.
///
/// Opens a bi-stream, sends the RPC request, reads the response,
/// and releases the connection back to the pool.
async fn send_publish_rpc(
    agent: &SdkAgent,
    pool: &ConnectionPool,
    addr: &str,
    publish_params_bytes: Vec<u8>,
) -> Result<(), crate::SdkError> {
    let (peer_id, conn) = pool.get_or_connect(agent, addr).await?;

    // Encode as RPC request with method = aafp.pubsub.publish
    // The params are the CBOR-encoded PublishParams (already bytes).
    // We need to wrap them in an RpcRequest. Since PubSubRpcHandler
    // expects params as a CBOR Value, we decode and re-encode, OR
    // we pass the raw bytes as the RPC params value.
    //
    // Simplest: decode the bytes to a Value, then use RpcRequest::with_params.
    let params_value = aafp_cbor::decode(&publish_params_bytes)
        .map_err(|e| crate::SdkError::Messaging(e.to_string()))?;

    let rpc_req = RpcRequest::new(1, METHOD_PUBLISH).with_params(params_value);
    let rpc_bytes = rpc_req.encode()
        .map_err(|e| crate::SdkError::Messaging(e.to_string()))?;

    let (mut send, mut recv) = conn.open_bi().await?;
    let frame = Frame::data(0, rpc_bytes);
    let frame_bytes = encode_frame(&frame)?;
    send.write_all(&frame_bytes).await?;
    send.finish();

    // Read response (empty map {})
    let mut header = [0u8; aafp_messaging::FRAME_HEADER_SIZE];
    recv.read_exact(&mut header).await?;
    let payload_len = u64::from_be_bytes(header[12..20].try_into().unwrap()) as usize;
    let ext_len = u64::from_be_bytes(header[20..28].try_into().unwrap()) as usize;
    let body_len = payload_len + ext_len;
    if body_len > 0 {
        let mut body = vec![0u8; body_len];
        recv.read_exact(&mut body).await?;
    }

    pool.release(&peer_id).await;
    Ok(())
}

/// Find a peer's address from the DHT by AgentId.
fn find_peer_addr(agent: &SdkAgent, peer_id: &AgentId) -> Option<String> {
    // Search all capabilities for the peer's record
    for cap in agent.dht.list_capabilities() {
        for record in agent.find_by_capability(&cap) {
            if &record.agent_id == peer_id {
                return record.endpoints.first().cloned();
            }
        }
    }
    None
}
```

#### 6.3 Triggering propagation on local publish

When the agent publishes locally (via `ConnectedAgent::publish()` or
`publish_local()`), the propagation driver must be notified. Two integration
points:

1. **Local publish from `ConnectedAgent::publish()`**: After calling
   `publish_local()`, also call `bridge.notify_local_publish(topic, from, data)`.
2. **Re-forwarding on remote publish**: When `PubSubRpcHandler::handle_publish()`
   calls `handle_remote_message()` and it returns `Ok(true)` (TTL > 0, should
   re-forward), the bridge must be notified. This requires hooking into the
   `handle_publish()` path. The cleanest approach: after the RPC handler
   returns, check if the method was `METHOD_PUBLISH` and the result was `Ok`,
   then call `notify_local_publish()` with the decoded `PublishParams`.

In the handler dispatch (Task 4), after `pubsub_bridge.rpc_handler().handle_request()`
returns `Ok(value)` for `METHOD_PUBLISH`, add:

```rust
// After successful publish handling, trigger re-forwarding if TTL > 0
if rpc_req.method == METHOD_PUBLISH {
    if let Ok(pp) = PublishParams::from_cbor(&rpc_req.params) {
        if pp.ttl > 0 {
            pubsub_bridge.notify_local_publish(
                pp.topic,
                caller_id,
                pp.data,
            );
        }
    }
}
```

This closes the loop: a remote publish arrives → `handle_remote_message()`
delivers locally and returns `Ok(true)` → the handler returns `Ok({})` → the
bridge is notified → the propagation driver forwards to other remote
subscribers with decremented TTL.

---

### Task 7: `NetworkedPubSub` modifications (`pubsub_v1.rs`)

Minimal changes to support the propagation driver:

1. **`local_publish_events()` channel**: Not strictly needed if the bridge
   uses `notify_local_publish()` directly. But if we want the propagation
   driver to also catch `publish_local()` calls (not just RPC-driven
   publishes), we need a way to hook. The simplest: the bridge wraps
   `publish_local()` with a notification. No change to `pubsub_v1.rs` needed
   for this.

2. **`seen_for()` helper** (design doc §3.3): Computes the initial seen list
   for a publish (includes our_id + from). This is trivial and can live in
   the bridge instead. No change needed.

3. **Make `NetworkedPubSub` cloneable or add `Arc` accessor**: The bridge
   already holds `Arc<NetworkedPubSub>`, so no change needed.

4. **Connection-close cleanup**: When a peer disconnects, its subscriptions
   must be removed. The `ServingAgent` per-connection task should call
   `pubsub.remove_peer(&peer_id)` when the connection loop breaks (line 667,
   the `Err(_) => break` arm). Add this to the handler dispatch:

```rust
// In the per-connection task, after the accept_bi loop breaks:
// (around line 831)
if let Some(bridge) = &pubsub_bridge {
    bridge.pubsub().remove_peer(&peer_id);
}
```

This ensures RFC-0009 §5 compliance: "subscriptions are per-connection — when
a connection closes, all subscriptions from that peer are removed."

---

### Task 8: `ConnectedAgent` local PubSub field

For P1 (local-only PubSub without a remote peer), the `ConnectedAgent` needs
an optional local `NetworkedPubSub`. Add this field:

```rust
pub struct ConnectedAgent {
    agent: Arc<SdkAgent>,
    pool: Arc<ConnectionPool>,
    /// Local PubSub instance for P1 local-only subscribe/publish.
    /// None unless the agent was configured with PubSub topics.
    local_pubsub: Option<Arc<tokio::sync::Mutex<NetworkedPubSub>>>,
}
```

Update `ConnectBuilder::connect()` (line 921) to initialize this. For P1, a
connected agent that wants local PubSub creates it lazily on first
`subscribe()` / `publish()` call. For P2, the connected agent may also need
a pubsub instance to receive forwarded messages (if it acts as both client
and server).

**Simplification for P1**: Make `local_pubsub` lazily initialized via
`tokio::sync::Mutex<Option<NetworkedPubSub>>`. On first `subscribe()` or
`publish()` with no address, create the instance.

---

### Task 9: Topic Registration and Subscriber Tracking

#### 9.1 Topic registration on the server

When `ServeBuilder::start()` creates the `NetworkedPubSub`, it pre-registers
all topics from `.topic()` calls by calling `pubsub.subscribe(topic)` (which
creates the broadcast channel). This ensures `publish_local()` succeeds for
those topics even before any subscriber connects.

Remote peers learn about topics by sending `aafp.pubsub.subscribe` RPC
requests. The `PubSubRpcHandler::handle_subscribe()` (line 507) calls
`add_remote_subscriber()`, which tracks the peer in the remote map. No
explicit topic registration RPC is needed — subscription IS the registration.

#### 9.2 Subscriber tracking

`NetworkedPubSub` already tracks:
- **Local subscribers**: via `broadcast::Receiver` count
  (`subscriber_count()`, line 438).
- **Remote subscribers**: via `remote: Arc<Mutex<HashMap<Topic, HashSet<AgentId>>>>`
  (`remote_subscribers()`, line 418).

The propagation driver uses `remote_subscribers(topic)` to find peers to
forward to. This is already implemented — the missing piece was calling it,
which the propagation driver (Task 6) now does.

#### 9.3 Connection-close cleanup

As noted in Task 7, call `remove_peer(&peer_id)` when a connection closes.
This removes all remote subscriptions for that peer, preventing stale
forwarding targets.

---

### Task 10: Unit Tests

#### 10.1 Local subscribe/publish (`simple.rs` tests module)

```rust
#[tokio::test]
async fn test_pubsub_event_text() {
    let ev = Event::text("hello");
    assert_eq!(ev.body(), "hello");
    assert_eq!(ev.payload(), None);
    assert_eq!(ev.encode_payload(), b"hello".to_vec());
}

#[tokio::test]
async fn test_pubsub_event_data() {
    let ev = Event::data(vec![1, 2, 3]);
    assert_eq!(ev.payload(), Some(&[1u8, 2, 3][..]));
    assert_eq!(ev.encode_payload(), vec![1, 2, 3]);
}

#[tokio::test]
async fn test_pubsub_event_from_topic_message() {
    use aafp_messaging::TopicMessage;
    let msg = TopicMessage {
        topic: "test.topic".to_string(),
        from: [42u8; 32],
        data: b"hello world".to_vec(),
    };
    let ev = Event::from_topic_message(&msg);
    assert_eq!(ev.topic(), "test.topic");
    assert_eq!(ev.from(), [42u8; 32]);
    assert_eq!(ev.body(), "hello world");
}

#[tokio::test]
async fn test_pubsub_local_subscribe_and_publish() {
    // P1: local-only subscribe/publish via NetworkedPubSub
    use aafp_messaging::NetworkedPubSub;
    use tokio::sync::Mutex;

    let pubsub = Arc::new(Mutex::new(NetworkedPubSub::new([1u8; 32])));
    let mut rx = pubsub.lock().await.subscribe("test-topic");

    // Publish locally
    pubsub.lock().await
        .publish_local("test-topic", [2u8; 32], b"hello".to_vec())
        .unwrap();

    let msg = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        rx.recv(),
    ).await.unwrap().unwrap();

    let ev = Event::from_topic_message(&msg);
    assert_eq!(ev.topic(), "test-topic");
    assert_eq!(ev.body(), "hello");
}

#[tokio::test]
async fn test_pubsub_multiple_local_subscribers() {
    use aafp_messaging::NetworkedPubSub;
    use tokio::sync::Mutex;

    let pubsub = Arc::new(Mutex::new(NetworkedPubSub::new([1u8; 32])));
    let mut rx1 = pubsub.lock().await.subscribe("fanout");
    let mut rx2 = pubsub.lock().await.subscribe("fanout");

    pubsub.lock().await
        .publish_local("fanout", [3u8; 32], b"broadcast".to_vec())
        .unwrap();

    let msg1 = tokio::time::timeout(
        std::time::Duration::from_secs(1), rx1.recv(),
    ).await.unwrap().unwrap();
    let msg2 = tokio::time::timeout(
        std::time::Duration::from_secs(1), rx2.recv(),
    ).await.unwrap().unwrap();

    assert_eq!(Event::from_topic_message(&msg1).body(), "broadcast");
    assert_eq!(Event::from_topic_message(&msg2).body(), "broadcast");
}

#[tokio::test]
async fn test_pubsub_subscribe_no_subscribers_error() {
    use aafp_messaging::NetworkedPubSub;
    let pubsub = NetworkedPubSub::new([1u8; 32]);
    // Publishing to a topic with no subscribers should error
    let result = pubsub.publish_local("no-subs", [2u8; 32], b"data".to_vec());
    assert!(result.is_err());
}
```

#### 10.2 ServeBuilder PubSub config tests

```rust
#[tokio::test]
async fn test_serve_builder_with_topic() {
    let builder = Agent::serve()
        .capability("test")
        .topic("events.topic1")
        .topic("events.topic2");
    assert_eq!(builder.pubsub_topics, vec!["events.topic1", "events.topic2"]);
}

#[tokio::test]
async fn test_serve_builder_with_on_publish() {
    let builder = Agent::serve()
        .on_publish("commands", |_topic, _ev| async move {});
    assert_eq!(builder.pubsub_on_publish.len(), 1);
    assert_eq!(builder.pubsub_on_publish[0].0, "commands");
}

#[tokio::test]
async fn test_serve_builder_topic_dedup() {
    let builder = Agent::serve()
        .topic("same.topic")
        .topic("same.topic");
    // Should not duplicate
    assert_eq!(builder.pubsub_topics.len(), 1);
}
```

#### 10.3 Propagation driver tests (`pubsub_bridge.rs` tests)

```rust
#[tokio::test]
async fn test_propagation_driver_forwards_to_remote_subscribers() {
    // Create two NetworkedPubSub instances (simulating two nodes)
    let node_a = Arc::new(NetworkedPubSub::new([1u8; 32]));
    let node_b = Arc::new(NetworkedPubSub::new([2u8; 32]));

    // Node B subscribes to "test-topic" on node A
    // (in reality, this happens via RPC; here we simulate the state)
    node_a.add_remote_subscriber("test-topic", [2u8; 32]);

    // Node B has a local subscriber
    let mut rx_b = node_b.subscribe("test-topic");

    // Node A publishes locally
    node_a.publish_local("test-topic", [1u8; 32], b"hello".to_vec()).unwrap();

    // The propagation driver on node A should forward to node B.
    // In this test, we simulate the forward by calling encode_publish_request
    // and handle_remote_message directly (full network test is in integration).
    let payload = node_a.encode_publish_request(
        "test-topic",
        b"hello".to_vec(),
        DEFAULT_TTL - 1,
        vec![[1u8; 32], [2u8; 32]],
    ).unwrap();

    // Decode and handle on node B
    let params = PublishParams::from_cbor(
        &aafp_cbor::decode(&payload).unwrap()
    ).unwrap();
    let should_reforward = node_b.handle_remote_message(&params, [1u8; 32]).unwrap();
    assert!(should_reforward); // TTL > 0

    // Node B's local subscriber should receive the message
    let msg = tokio::time::timeout(
        std::time::Duration::from_secs(1), rx_b.recv(),
    ).await.unwrap().unwrap();
    assert_eq!(msg.data, b"hello");
    assert_eq!(msg.from, [1u8; 32]);
}

#[tokio::test]
async fn test_propagation_seen_list_prevents_loops() {
    let node = Arc::new(NetworkedPubSub::new([1u8; 32]));
    let mut rx = node.subscribe("loop-test");

    // First delivery: should succeed
    let params1 = PublishParams {
        topic: "loop-test".to_string(),
        data: b"msg".to_vec(),
        ttl: 3,
        seen: vec![[2u8; 32]],
    };
    let result1 = node.handle_remote_message(&params1, [2u8; 32]);
    assert!(result1.is_ok());

    // Second delivery of same message: should be dropped (AlreadySeen)
    let params2 = PublishParams {
        topic: "loop-test".to_string(),
        data: b"msg".to_vec(),
        ttl: 3,
        seen: vec![[2u8; 32]],
    };
    let result2 = node.handle_remote_message(&params2, [2u8; 32]);
    assert!(matches!(result2, Err(PubSubV1Error::AlreadySeen)));
}

#[tokio::test]
async fn test_propagation_ttl_zero_not_reforwarded() {
    let node = Arc::new(NetworkedPubSub::new([1u8; 32]));
    let mut rx = node.subscribe("ttl-test");

    // TTL = 0: deliver locally but don't re-forward
    let params = PublishParams {
        topic: "ttl-test".to_string(),
        data: b"msg".to_vec(),
        ttl: 0,
        seen: vec![],
    };
    let should_reforward = node.handle_remote_message(&params, [2u8; 32]).unwrap();
    assert!(!should_reforward); // TTL = 0, don't re-forward

    // But local delivery still happened
    let msg = tokio::time::timeout(
        std::time::Duration::from_secs(1), rx.recv(),
    ).await.unwrap().unwrap();
    assert_eq!(msg.data, b"msg");
}
```

#### 10.4 Integration test: serve + subscribe + publish (`pubsub_test.rs`)

```rust
// aafp-sdk/tests/pubsub_test.rs
use aafp_sdk::simple::{Agent, Event, Request, Response};
use aafp_messaging::NetworkedPubSub;
use std::sync::Arc;
use tokio::sync::Mutex;

#[tokio::test]
async fn test_serve_with_topic_and_publish() {
    // Server with a topic
    let server = Agent::serve()
        .capability("test")
        .topic("events")
        .start()
        .await
        .unwrap();

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    // The server should have a NetworkedPubSub with the "events" topic
    // (verified internally; here we test the external API)

    server.stop();
}

#[tokio::test]
async fn test_on_publish_handler_receives_events() {
    use std::sync::atomic::{AtomicBool, Ordering};

    let received = Arc::new(AtomicBool::new(false));
    let received_clone = received.clone();

    let server = Agent::serve()
        .on_publish("test.commands", move |_topic, ev| {
            let received = received_clone.clone();
            async move {
                if ev.body() == "ping" {
                    received.store(true, Ordering::SeqCst);
                }
            }
        })
        .start()
        .await
        .unwrap();

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    // Publish to the topic (would need a client connected to the server's
    // pubsub, or direct local publish for P1)
    // For P1 local test: access the server's pubsub and publish locally
    // (requires exposing the pubsub on ServingAgent, or a test helper)

    // For P2: client connects and publishes via RPC
    // let client = Agent::connect().connect().await.unwrap();
    // client.publish_to("test.commands", Event::text("ping"), server.addr())
    //     .await.unwrap();
    // tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    // assert!(received.load(Ordering::SeqCst));

    server.stop();
}

#[tokio::test]
async fn test_subscribe_and_publish_local() {
    // P1: local-only subscribe/publish through ConnectedAgent
    let agent = Agent::connect().connect().await.unwrap();

    // Subscribe to a topic
    let mut events = agent.subscribe("local.topic").await.unwrap();

    // Publish locally
    agent.publish("local.topic", Event::text("hello local")).await.unwrap();

    // Receive the event
    let event = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        events.next(),
    ).await.unwrap().unwrap().unwrap();

    assert_eq!(event.topic(), "local.topic");
    assert_eq!(event.body(), "hello local");
}
```

#### 10.5 3-node floodsub integration test (P2)

```rust
#[tokio::test]
async fn test_floodsub_3_node_propagation() {
    // Node A publishes, Node B and C subscribe.
    // A → B (direct), A → C (via B re-forwarding, or direct if C subscribed to A).
    //
    // Setup:
    // 1. Start 3 servers: A, B, C — each with PubSub enabled.
    // 2. B and C send aafp.pubsub.subscribe to A for topic "news".
    // 3. A publishes "hello" to "news".
    // 4. Both B and C should receive the event within 50ms.
    //
    // This test requires:
    // - All 3 nodes running with PubSub.
    // - B and C discover A (via DHT or direct address).
    // - B and C call subscribe_to(A.addr(), "news").
    // - A calls publish("news", Event::text("hello")).
    // - Assert both B and C receive the event.
    //
    // Mark as #[ignore] until P2 propagation is fully wired,
    // then enable it as the acceptance test.

    // ... (full implementation in the test file)
}
```

---

## Acceptance Criteria

- [ ] `Event::text("hi")` and `Event::data(vec![...])` construct events; `body()`,
      `payload()`, `topic()`, `from()`, `timestamp()` accessors work.
- [ ] `Event::from_topic_message()` decodes a `TopicMessage` into an `Event`.
- [ ] `SubscriptionStream::next()` yields `Result<Event, SdkError>`.
- [ ] `ServeBuilder::topic("x")` registers a topic; `pubsub_topics` is populated.
- [ ] `ServeBuilder::on_publish("x", handler)` registers a handler; the handler
      is invoked when a message is published to "x" locally.
- [ ] `ServeBuilder::start()` creates a `NetworkedPubSub` and `PubSubBridge` when
      PubSub is configured.
- [ ] The `ServingAgent` handler loop dispatches `aafp.pubsub.subscribe`,
      `aafp.pubsub.unsubscribe`, `aafp.pubsub.publish` to `PubSubRpcHandler`.
- [ ] `ConnectedAgent::subscribe("x")` returns a `SubscriptionStream` that yields
      events (local-only for P1, networked for P2).
- [ ] `ConnectedAgent::publish("x", Event::text("hi"))` publishes an event
      (local-only for P1, networked for P2).
- [ ] The propagation driver forwards published messages to `remote_subscribers()`
      with decremented TTL and updated `seen` list.
- [ ] `encode_publish_request()` is called by the propagation driver (fixing the
      open loop).
- [ ] Connection-close cleanup calls `remove_peer()` (RFC-0009 §5).
- [ ] Seen-cache dedup prevents message loops (test_propagation_seen_list).
- [ ] TTL=0 messages are delivered locally but not re-forwarded.
- [ ] All unit tests pass: `cargo test -p aafp-sdk` and `cargo test -p aafp-messaging`.
- [ ] `cargo fmt --all -- --check` passes (0 diffs).
- [ ] `cargo clippy --workspace` passes (0 warnings).

---

## Implementation Order

1. **`Event` type** (Task 1) — no dependencies, pure data type.
2. **`SubscriptionStream`** (Task 2) — no dependencies, wraps mpsc.
3. **`ServeBuilder` fields + `.topic()` / `.on_publish()`** (Task 3) — depends on
   Task 1 for `Event` in the `on_publish` handler signature.
4. **`PubSubBridge`** (Task 6) — depends on `NetworkedPubSub` (exists). Start with
   the non-pool version (Task 6.1), then add pool integration (Task 6.2).
5. **Wire `PubSubRpcHandler` into handler dispatch** (Task 4) — depends on
   `PubSubBridge` existing. Requires extracting `peer_id` from the session.
6. **`ConnectedAgent::subscribe()` / `publish()`** (Tasks 5, 8) — depends on
   `Event`, `SubscriptionStream`, and `PubSubBridge` for local pubsub.
7. **`NetworkedPubSub` cleanup** (Task 7) — add `remove_peer()` call on
   connection close.
8. **Tests** (Task 10) — write unit tests alongside each task; write integration
   tests after P2 propagation is wired.

---

## Key Pitfalls

1. **`peer_id` extraction**: The current handler loop (line 649) calls
   `establish_session()` which returns `(session, conn, peer_info)`, but
   `peer_info.agent_id` is not captured. You must capture it and pass it into
   the per-bi-stream task as `caller_id` for PubSub dispatch.

2. **RPC params encoding**: `PubSubRpcHandler::handle_request()` expects
   `params: &Value` and calls `SubscribeParams::from_cbor(params)` /
   `PublishParams::from_cbor(params)`. The RPC request's `params` field must be
   the CBOR map from `to_cbor()`, not wrapped in an extra layer. Verify the wire
   format matches by round-tripping: encode `SubscribeParams::to_cbor()` as RPC
   params, send, decode, and call `from_cbor()`.

3. **Broadcast vs mpsc**: `NetworkedPubSub` uses `broadcast::Sender` for local
   fan-out (multiple subscribers per topic). `SubscriptionStream` uses
   `mpsc::Receiver` (single consumer per stream). The bridge must convert
   `broadcast::Receiver<TopicMessage>` → `mpsc::Sender<Result<Event, SdkError>>`
   via a spawned forwarder task (shown in Task 5.1).

4. **`publish_local()` requires the topic to exist**: Calling `publish_local()`
   on a topic with no broadcast channel returns `TopicNotFound`. The
   `ServeBuilder::start()` must pre-register topics by calling `subscribe()`
   (which creates the channel) even if no consumer is attached yet.

5. **Propagation driver concurrency**: Forwarding to multiple peers should be
   concurrent (`futures::join_all` or `tokio::spawn` per peer) to avoid head-of-
   line blocking. For P2, sequential is acceptable; optimize in P6 (gossipsub).

6. **`seen` list growth**: The `seen` list grows with each hop. For large floods,
   this can get expensive. The 60s seen-cache (`SeenCache`) handles dedup at the
   message level; the `seen` list is for per-hop loop prevention. Both are needed.

7. **Connection pool and propagation**: The propagation driver needs the
   `ConnectionPool` and `SdkAgent` to dial peers. These are created in
   `ServeBuilder::start()` but the bridge is also created there. Ensure the
   bridge receives `Arc` clones of both. The `ServingAgent` currently does not
   have a `ConnectionPool` (it only accepts inbound). For P2, the server needs
   outbound dialing capability for propagation. Add a `ConnectionPool` to
   `ServingAgent` or pass it to the bridge.

8. **Backward compatibility**: Agents without PubSub configured (`no .topic()`
   or `.on_publish()` calls) must behave exactly as before. The `pubsub_bridge`
   is `Option<Arc<PubSubBridge>>` and the dispatch arm is skipped when `None`.
   The `if rpc_req.method.starts_with("aafp.pubsub.")` check returns an error
   when PubSub is not enabled, which is correct (method not supported).

---

## References

- **RFC-0009** §2 (wire format), §3 (floodsub), §5 (security)
- **`PUBSUB_BACKCHANNEL_DESIGN.md`** §3.1-3.4 (Simple API), §3.3 (propagation
  driver), §7.2 (QUIC stream mapping), §9 (P1/P2 roadmap)
- **`pubsub_v1.rs`** — existing `NetworkedPubSub`, `PubSubRpcHandler`,
  `PublishParams`, `SeenCache`
- **`simple.rs`** — `ServeBuilder` (line 518), `ServingAgent` handler loop
  (line 630), `ConnectedAgent` (line 939), `call_agent_with_pool` (line 1376)
- **`connection_pool.rs`** — `get_or_connect()` (line 176), `release()` (line 271)
