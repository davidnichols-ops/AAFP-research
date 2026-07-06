# Builder Prompt: PubSub Phase P5-P6 — Security/UCAN + GossipSub Upgrade

## Objective

Implement UCAN-based authorization for PubSub topics, per-connection resource
limits with new error codes, and upgrade the floodsub propagation layer to
GossipSub v1.1 with peer scoring, mesh construction, and heartbeat-based mesh
maintenance. This phase hardens the PubSub layer for production multi-agent
networks and replaces the O(subscribers) amplification of floodsub with a
bounded-degree mesh.

## Context

Read these design documents and source files before starting:

- `PUBSUB_BACKCHANNEL_DESIGN.md` — §6.4 (ACLs via UCAN), §6.5 (per-connection
  limits), §10 (error codes), §11 (security considerations), Phase P6
  (Gossipsub roadmap).
- `implementations/rust/crates/aafp-identity/src/ucan.rs` — `UcanToken`,
  `Capability`, `verify_chain()`, `caps_compatible()`. The `Capability` struct
  has `resource: String`, `action: String`, `constraints: Option<Value>`.
- `implementations/rust/crates/aafp-messaging/src/pubsub_v1.rs` — existing
  floodsub implementation: `NetworkedPubSub`, `PubSubRpcHandler`, `SeenCache`,
  `PublishParams`, `SubscribeParams`.
- `implementations/rust/crates/aafp-core/src/authz.rs` — `AuthorizationProvider`
  trait to extend.
- `RFCs/0009-pubsub.md` — wire format (forward-compatible with gossipsub).
- `AGENTS.md` — build/test commands and conventions.

## Part 1: UCAN-Based ACLs for Topics

### 1.1 Capability Encoding

A PubSub UCAN capability is encoded as a CBOR text string in the
`Capability.resource` field, with `action` set to `"pubsub"`:

```
"pubsub/<topic_filter>/<action>"
```

Where `<action>` is `publish` or `subscribe`, and `<topic_filter>` uses the
MQTT-style wildcard syntax from `PUBSUB_BACKCHANNEL_DESIGN.md` Appendix B
(`+` single-level, `#` multi-level). Examples:

- `"pubsub/tasks.*/subscribe"` — subscribe to any `tasks.*` topic
- `"pubsub/agents.A.inbox/publish"` — publish to agent A's inbox
- `"pubsub/rpc.A.#/publish"` — publish back-channel events for A's RPCs

### 1.2 TopicAcl Structure

Create `crates/aafp-messaging/src/pubsub_acl.rs`:

```rust
use aafp_identity::agent_id::AgentId;
use aafp_identity::ucan::{Capability, UcanToken};
use std::collections::HashMap;

/// Action permitted on a topic.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TopicAction {
    Publish,
    Subscribe,
}

impl TopicAction {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Publish => "publish",
            Self::Subscribe => "subscribe",
        }
    }
}

/// Parsed pubsub capability: `pubsub/<filter>/<action>`.
#[derive(Clone, Debug)]
pub struct PubSubCapability {
    pub topic_filter: String,
    pub action: TopicAction,
}

impl PubSubCapability {
    /// Parse a capability resource string like "pubsub/tasks.*/subscribe".
    pub fn parse(resource: &str) -> Option<Self> {
        let rest = resource.strip_prefix("pubsub/")?;
        let last_slash = rest.rfind('/')?;
        let (filter, action_str) = rest.split_at(last_slash);
        let action_str = &action_str[1..]; // skip the '/'
        let action = match action_str {
            "publish" => TopicAction::Publish,
            "subscribe" => TopicAction::Subscribe,
            _ => return None,
        };
        Some(Self {
            topic_filter: filter.to_string(),
            action,
        })
    }
}

/// UCAN-backed ACL for PubSub topics.
///
/// Stores verified UCAN tokens per agent. `check()` walks the agent's
/// capability chain and matches the requested (topic, action) against
/// any granted capability whose filter matches the topic.
pub struct TopicAcl {
    /// agent_id -> verified UCAN tokens (chain leaf tokens)
    grants: HashMap<AgentId, Vec<UcanToken>>,
    /// Optional pubkey resolver for chain verification (post-MVP: KeyDirectory)
    resolver: Option<Arc<dyn PubkeyResolver>>,
}

impl TopicAcl {
    pub fn new() -> Self {
        Self {
            grants: HashMap::new(),
            resolver: None,
        }
    }

    /// Register a verified UCAN token granting pubsub capabilities to its audience.
    pub fn grant(&mut self, token: UcanToken) {
        let aud = aafp_identity::agent_id::agent_id_from_hex(&token.payload.aud);
        if let Some(aud_id) = aud {
            self.grants.entry(aud_id).or_default().push(token);
        }
    }

    /// Check whether `caller` is authorized for `(topic, action)`.
    pub fn check(&self, caller: &AgentId, topic: &str, action: TopicAction) -> bool {
        let Some(tokens) = self.grants.get(caller) else {
            return false;
        };
        tokens.iter().any(|token| {
            token.payload.cap.iter().any(|cap| {
                Self::cap_matches(cap, topic, action)
            })
        })
    }

    fn cap_matches(cap: &Capability, topic: &str, action: TopicAction) -> bool {
        let Some(psc) = PubSubCapability::parse(&cap.resource) else {
            return false;
        };
        psc.action == action && topic_matches(&psc.topic_filter, topic)
    }
}
```

### 1.3 ACL Authorization Provider

Implement the `AuthorizationProvider` trait from `aafp-core`:

```rust
use aafp_core::authz::AuthorizationProvider;
use std::sync::Arc;

pub struct AclAuthorizationProvider {
    acl: Arc<RwLock<TopicAcl>>,
    /// Default policy when no ACL entry exists: true = allow (backward compat),
    /// false = deny. Default is true to match RFC-0009 §5.
    default_allow: bool,
}

impl AclAuthorizationProvider {
    pub fn new(acl: TopicAcl) -> Self {
        Self {
            acl: Arc::new(RwLock::new(acl)),
            default_allow: true,
        }
    }

    pub fn with_default_deny(mut self) -> Self {
        self.default_allow = false;
        self
    }
}

impl AuthorizationProvider for AclAuthorizationProvider {
    fn authorize(
        &self,
        caller: &AgentId,
        capability: &str,
        _resource: &str,
    ) -> Result<(), AuthzError> {
        // capability is "pubsub.<topic>.<action>" or "pubsub/<topic>/<action>"
        let parsed = capability
            .strip_prefix("pubsub.")
            .or_else(|| capability.strip_prefix("pubsub/"));
        let Some(rest) = parsed else {
            return if self.default_allow { Ok(()) }
                else { Err(AuthzError::Denied) };
        };
        let last_sep = rest.rfind(['/', '.'])?;
        let (topic, action_str) = rest.split_at(last_sep);
        let action = match &action_str[1..] {
            "publish" => TopicAction::Publish,
            "subscribe" => TopicAction::Subscribe,
            _ => return Ok(()), // unknown action, defer to default
        };
        let acl = self.acl.read().await;
        if acl.check(caller, topic, action) {
            Ok(())
        } else if self.default_allow {
            Ok(())
        } else {
            Err(AuthzError::Denied)
        }
    }
}
```

### 1.4 Publish Authorization

In `PubSubRpcHandler::handle_publish`, before accepting the message:

```rust
async fn authorize_publish(
    &self,
    caller: &AgentId,
    topic: &str,
) -> Result<(), PubSubError> {
    if let Some(ref authz) = self.authz {
        authz.authorize(caller, &format!("pubsub/{topic}/publish"), topic)
            .map_err(|_| PubSubError::PublishDenied)?;
    }
    Ok(())
}
```

### 1.5 Subscribe Authorization

In `PubSubRpcHandler::handle_subscribe`, before adding to the subscription map:

```rust
async fn authorize_subscribe(
    &self,
    caller: &AgentId,
    topic: &str,
) -> Result<(), PubSubError> {
    if let Some(ref authz) = self.authz {
        authz.authorize(caller, &format!("pubsub/{topic}/subscribe"), topic)
            .map_err(|_| PubSubError::SubscribeDenied)?;
    }
    Ok(())
}
```

## Part 2: Per-Connection Limits

### 2.1 ConnectionLimits Config

Add to `crates/aafp-messaging/src/pubsub_v1.rs`:

```rust
/// Per-connection resource limits for PubSub.
#[derive(Clone, Debug)]
pub struct ConnectionLimits {
    /// Maximum simultaneous subscriptions per connection (default 1024).
    pub max_subscriptions: usize,
    /// Maximum publish RPC calls per second per connection (default 100).
    pub max_publish_rate: u32,
    /// Maximum message payload size in bytes (default 1 MiB).
    pub max_message_size: usize,
    /// Maximum topic string length (default 256).
    pub max_topic_length: usize,
    /// Maximum topic hierarchy depth (default 16).
    pub max_topic_depth: usize,
}

impl Default for ConnectionLimits {
    fn default() -> Self {
        Self {
            max_subscriptions: 1024,
            max_publish_rate: 100,
            max_message_size: 1024 * 1024,
            max_topic_length: 256,
            max_topic_depth: 16,
        }
    }
}
```

### 2.2 Per-Connection State Tracking

```rust
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// Tracks per-connection PubSub state for limit enforcement.
pub struct ConnectionState {
    pub subscriptions: HashSet<String>,
    pub publish_timestamps: VecDeque<Instant>,
}

impl ConnectionState {
    pub fn new() -> Self {
        Self {
            subscriptions: HashSet::new(),
            publish_timestamps: VecDeque::new(),
        }
    }

    /// Check and record a publish; returns Err if rate-limited.
    pub fn check_publish_rate(&mut self, limit: u32) -> Result<(), PubSubError> {
        let now = Instant::now();
        let window = Duration::from_secs(1);
        // Evict timestamps older than 1 second.
        while let Some(front) = self.publish_timestamps.front() {
            if now.duration_since(*front) > window {
                self.publish_timestamps.pop_front();
            } else {
                break;
            }
        }
        if self.publish_timestamps.len() >= limit as usize {
            return Err(PubSubError::RateLimited);
        }
        self.publish_timestamps.push_back(now);
        Ok(())
    }
}

/// Map of peer AgentId -> ConnectionState, guarded by a Mutex.
pub type ConnectionStates = Arc<Mutex<HashMap<AgentId, ConnectionState>>>;
```

### 2.3 Enforcement in Handler

In `handle_subscribe`:

```rust
let mut states = self.conn_states.lock().await;
let state = states.entry(*caller).or_insert_with(ConnectionState::new);
if state.subscriptions.len() >= self.limits.max_subscriptions {
    return Err(PubSubError::SubscribeDenied); // 9008
}
state.subscriptions.insert(topic.to_string());
```

In `handle_publish`:

```rust
// Check message size
if data.len() > self.limits.max_message_size {
    return Err(PubSubError::MessageTooLarge); // 9010
}
// Check topic length/depth
if topic.len() > self.limits.max_topic_length {
    return Err(PubSubError::TopicNotFound); // 9006
}
// Check publish rate
let mut states = self.conn_states.lock().await;
let state = states.entry(*caller).or_insert_with(ConnectionState::new);
state.check_publish_rate(self.limits.max_publish_rate)?;
```

## Part 3: New Error Codes

Add to `crates/aafp-messaging/src/pubsub_v1.rs` (RFC-0005 extension):

```rust
/// PubSub-specific error codes (RFC-0005 extension).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PubSubError {
    /// 9006: Topic does not exist or is malformed.
    TopicNotFound,
    /// 9007: Caller lacks pubsub/<topic>/publish capability.
    PublishDenied,
    /// 9008: Caller lacks pubsub/<topic>/subscribe capability or sub limit hit.
    SubscribeDenied,
    /// 9009: Publish rate limit exceeded for this connection.
    RateLimited,
    /// 9010: Message payload exceeds max_message_size.
    MessageTooLarge,
}

impl PubSubError {
    pub fn code(&self) -> u32 {
        match self {
            Self::TopicNotFound => 9006,
            Self::PublishDenied => 9007,
            Self::SubscribeDenied => 9008,
            Self::RateLimited => 9009,
            Self::MessageTooLarge => 9010,
        }
    }

    pub fn message(&self) -> &'static str {
        match self {
            Self::TopicNotFound => "topic not found or malformed",
            Self::PublishDenied => "publish denied: insufficient UCAN capability",
            Self::SubscribeDenied => "subscribe denied: insufficient capability or limit exceeded",
            Self::RateLimited => "publish rate limit exceeded",
            Self::MessageTooLarge => "message payload exceeds maximum size",
        }
    }
}
```

Map these to RPC error responses in `PubSubRpcHandler::dispatch`:

```rust
Err(e) => RpcResponse::error(e.code(), e.message()),
```

## Part 4: GossipSub v1.1 Upgrade from Floodsub

### 4.1 Upgrade Path

The wire format (RFC-0009) is forward-compatible — only the propagation logic
changes. The upgrade replaces the floodsub propagation driver (which forwards
to *all* subscribers) with a mesh-based gossip protocol:

1. **Mesh construction**: each peer maintains a partial mesh of `D` peers per
   topic (not all subscribers).
2. **IHAVE/IWANT gossip**: peers gossip about message IDs via control messages;
   missing messages are requested on-demand.
3. **Peer scoring**: misbehaving peers are penalized and eventually pruned.
4. **Heartbeat**: periodic mesh maintenance re-balances degree.

### 4.2 GossipSub Configuration

Create `crates/aafp-messaging/src/gossipsub.rs`:

```rust
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

/// GossipSub v1.1 mesh parameters (libp2p defaults).
#[derive(Clone, Debug)]
pub struct GossipSubConfig {
    /// Mesh target degree (ideal number of peers per topic in the mesh).
    pub d: usize,
    /// Mesh lower bound — if mesh drops below D_lo, graft new peers.
    pub d_lo: usize,
    /// Mesh upper bound — if mesh exceeds D_hi, prune excess peers.
    pub d_hi: usize,
    /// Number of peers to gossip to per heartbeat (lazy gossip fanout).
    pub d_lazy: usize,
    /// Heartbeat interval for mesh maintenance.
    pub heartbeat_interval: Duration,
    /// History retention for IWANT (how long to remember seen message IDs).
    pub fanout_ttl: Duration,
    /// Maximum message size (mirrors ConnectionLimits.max_message_size).
    pub max_message_size: usize,
    /// Peer scoring thresholds.
    pub scoring: PeerScoringConfig,
}

impl Default for GossipSubConfig {
    fn default() -> Self {
        Self {
            d: 6,
            d_lo: 4,
            d_hi: 12,
            d_lazy: 6,
            heartbeat_interval: Duration::from_secs(1),
            fanout_ttl: Duration::from_secs(60),
            max_message_size: 1024 * 1024,
            scoring: PeerScoringConfig::default(),
        }
    }
}
```

### 4.3 Mesh State

```rust
/// Per-topic mesh state.
#[derive(Clone, Debug)]
pub struct MeshState {
    /// Peers currently in the mesh for this topic.
    pub peers: HashSet<AgentId>,
    /// Peers we've gossiped to recently (for IWANT tracking).
    pub gossip_peers: HashSet<AgentId>,
    /// Message IDs seen recently (for IHAVE gossip).
    pub seen_msgs: VecDeque<[u8; 32]>,
    /// Last time we had mesh members (for fanout TTL).
    pub last_active: Instant,
}

/// GossipSub router state, replacing the floodsub propagation driver.
pub struct GossipSubRouter {
    config: GossipSubConfig,
    /// topic -> mesh state
    mesh: HashMap<String, MeshState>,
    /// peer -> score
    peer_scores: HashMap<AgentId, PeerScore>,
    /// message hash -> expiry (seen cache, content-addressed)
    seen: HashMap<[u8; 32], Instant>,
}
```

## Part 5: Peer Scoring (7 Parameters)

GossipSub v1.1 peer scoring penalizes misbehaving peers and rewards good
citizens. A peer's total score is a weighted sum of 7 components:

```rust
/// Peer scoring configuration — 7 weighted parameters.
#[derive(Clone, Debug)]
pub struct PeerScoringConfig {
    // ── P1: App-specific score (topic-specific behavior) ──
    pub p1_weight: f64,
    pub p1_cap: f64,

    // ── P2: IP colocation penalty (many peers from same IP) ──
    pub p2_weight: f64,
    pub p2_colocation_threshold: usize,

    // ── P3: Behavioral penalty (invalid messages, spam) ──
    pub p3_weight: f64,
    pub p3_decay: f64,

    // ── P4: Application-specific reward (e.g. useful data) ──
    pub p4_weight: f64,

    // ── P5: Message delivery time (latency-based) ──
    pub p5_weight: f64,

    // ── P6: Mesh participation (in mesh vs. not) ──
    pub p6_weight: f64,

    // ── P7: First-message deliveries (reward for novelty) ──
    pub p7_weight: f64,

    /// Score below which a peer is graylisted (not pruned, but not gossiped to).
    pub graylist_threshold: f64,
    /// Score below which a peer is pruned from all meshes.
    pub prune_threshold: f64,
    /// Time window for score decay.
    pub decay_interval: Duration,
}

impl Default for PeerScoringConfig {
    fn default() -> Self {
        Self {
            p1_weight: 10.0,
            p1_cap: 100.0,
            p2_weight: -10.0,
            p2_colocation_threshold: 5,
            p3_weight: -100.0,
            p3_decay: 0.9,
            p4_weight: 5.0,
            p5_weight: -2.0,
            p6_weight: 1.0,
            p7_weight: 1.0,
            graylist_threshold: -100.0,
            prune_threshold: -1000.0,
            decay_interval: Duration::from_secs(10),
        }
    }
}

/// Per-peer score breakdown.
#[derive(Clone, Debug, Default)]
pub struct PeerScore {
    pub p1_app_specific: f64,
    pub p2_ip_colocation: f64,
    pub p3_behavioral: f64,
    pub p4_app_reward: f64,
    pub p5_latency: f64,
    pub p6_mesh_participation: f64,
    pub p7_first_deliveries: f64,
    pub last_updated: Option<Instant>,
}

impl PeerScore {
    pub fn total(&self) -> f64 {
        self.p1_app_specific
            + self.p2_ip_colocation
            + self.p3_behavioral
            + self.p4_app_reward
            + self.p5_latency
            + self.p6_mesh_participation
            + self.p7_first_deliveries
    }

    /// Decay all components toward zero (called periodically).
    pub fn decay(&mut self, cfg: &PeerScoringConfig) {
        let d = cfg.p3_decay;
        self.p1_app_specific *= d;
        self.p3_behavioral *= d;
        self.p5_latency *= d;
        self.p7_first_deliveries *= d;
    }

    /// Record an invalid message from this peer (P3 penalty).
    pub fn record_invalid_message(&mut self, penalty: f64) {
        self.p3_behavioral -= penalty;
    }

    /// Record a first-message delivery (P7 reward).
    pub fn record_first_delivery(&mut self, reward: f64) {
        self.p7_first_deliveries += reward;
    }
}
```

### 5.1 Scoring Integration

```rust
impl GossipSubRouter {
    /// Update peer score after receiving a message.
    pub fn score_on_message(
        &mut self,
        peer: &AgentId,
        msg_hash: [u8; 32],
        is_first_seen: bool,
    ) {
        let score = self.peer_scores.entry(*peer).or_default();
        if is_first_seen {
            score.record_first_delivery(self.config.scoring.p7_weight);
        }
        score.last_updated = Some(Instant::now());
    }

    /// Check if a peer should be pruned from meshes.
    pub fn should_prune(&self, peer: &AgentId) -> bool {
        self.peer_scores
            .get(peer)
            .is_some_and(|s| s.total() < self.config.scoring.prune_threshold)
    }

    /// Periodic score decay for all peers.
    pub fn decay_all_scores(&mut self) {
        let cfg = &self.config.scoring;
        for score in self.peer_scores.values_mut() {
            score.decay(cfg);
        }
    }
}
```

## Part 6: Mesh Construction (D_lo, D_hi, D_lazy)

```rust
impl GossipSubRouter {
    /// Ensure mesh for `topic` has between D_lo and D_hi peers.
    /// Called during heartbeat.
    pub fn maintain_mesh(&mut self, topic: &str, available: &[AgentId]) {
        let state = self.mesh.entry(topic.to_string())
            .or_insert_with(|| MeshState {
                peers: HashSet::new(),
                gossip_peers: HashSet::new(),
                seen_msgs: VecDeque::new(),
                last_active: Instant::now(),
            });

        // Prune low-scoring peers from mesh.
        state.peers.retain(|p| !self.should_prune(p));

        let cfg = &self.config;

        // Graft: if below D_lo, add peers up to D.
        if state.peers.len() < cfg.d_lo {
            let candidates: Vec<_> = available
                .iter()
                .filter(|p| !state.peers.contains(p) && !self.should_prune(p))
                .take(cfg.d - state.peers.len())
                .cloned()
                .collect();
            for c in candidates {
                state.peers.insert(c);
                // Send GRAFT control message (RFC-0009 extension)
            }
        }

        // Prune: if above D_hi, remove excess (lowest-scoring first).
        if state.peers.len() > cfg.d_hi {
            let mut sorted: Vec<_> = state.peers.iter().collect();
            sorted.sort_by(|a, b| {
                let sa = self.peer_scores.get(a).map(|s| s.total()).unwrap_or(0.0);
                let sb = self.peer_scores.get(b).map(|s| s.total()).unwrap_or(0.0);
                sa.partial_cmp(&sb).unwrap_or(std::cmp::Ordering::Equal)
            });
            let to_remove = state.peers.len() - cfg.d;
            for peer in sorted.into_iter().take(to_remove) {
                state.peers.remove(peer);
                // Send PRUNE control message
            }
        }

        state.last_active = Instant::now();
    }

    /// Select D_lazy peers to gossip IHAVE messages to.
    pub fn select_gossip_peers(&self, topic: &str) -> Vec<AgentId> {
        let Some(state) = self.mesh.get(topic) else {
            return vec![];
        };
        let cfg = &self.config;
        state
            .peers
            .iter()
            .filter(|p| {
                self.peer_scores
                    .get(p)
                    .is_some_and(|s| s.total() > cfg.scoring.graylist_threshold)
            })
            .take(cfg.d_lazy)
            .cloned()
            .collect()
    }
}
```

## Part 7: Heartbeat Protocol

```rust
impl GossipSubRouter {
    /// Run the heartbeat loop — mesh maintenance, score decay, fanout TTL.
    /// Spawn this as a background task alongside the propagation driver.
    pub async fn heartbeat_loop(
        router: Arc<Mutex<Self>>,
        available_peers: Arc<dyn Fn() -> Vec<AgentId> + Send + Sync>,
        shutdown: CancellationToken,
    ) {
        let interval = router.lock().await.config.heartbeat_interval;
        let mut ticker = tokio::time::interval(interval);

        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    let peers = available_peers();
                    let mut r = router.lock().await;

                    // 1. Decay all peer scores.
                    r.decay_all_scores();

                    // 2. Maintain mesh for each topic.
                    let topics: Vec<String> = r.mesh.keys().cloned().collect();
                    for topic in &topics {
                        r.maintain_mesh(topic, &peers);
                    }

                    // 3. Evict expired seen messages.
                    let now = Instant::now();
                    let fanout_ttl = r.config.fanout_ttl;
                    r.seen.retain(|_, expiry| now.duration_since(*expiry) < fanout_ttl);

                    // 4. Emit IHAVE gossip to D_lazy peers per topic.
                    // (Control messages piggybacked on next publish frame.)
                }
                _ = shutdown.cancelled() => break,
            }
        }
    }
}
```

### 7.1 IHAVE/IWANT Gossip

```rust
/// Gossip control messages (piggybacked on publish frames or sent standalone).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GossipControl {
    /// IHAVE: "I have these message IDs" — sent to D_lazy peers.
    pub ihave: HashMap<String, Vec<[u8; 32]>>,  // topic -> msg_hashes
    /// IWANT: "I want these message IDs" — sent in response to IHAVE.
    pub iwant: Vec<[u8; 32]>,                    // msg_hashes
    /// GRAFT: "Add me to your mesh for this topic."
    pub graft: Vec<String>,                      // topics
    /// PRUNE: "Remove me from your mesh for this topic."
    pub prune: Vec<String>,                      // topics
}
```

## Part 8: Integration into PubSubRpcHandler

Replace the floodsub propagation in `NetworkedPubSub` with the gossipsub
router. The `PubSubRpcHandler` gains an `Option<Arc<Mutex<GossipSubRouter>>>`
field. When present, `handle_publish` routes through the mesh instead of
flooding all subscribers:

```rust
// In handle_publish, after authorization + limits:
if let Some(ref router) = self.gossip_router {
    let mut r = router.lock().await;
    let mesh_peers = r.mesh.get(&topic)
        .map(|m| m.peers.iter().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    // Forward to mesh peers only (not all subscribers).
    for peer in mesh_peers {
        let payload = self.encode_publish_request(
            &topic, data.clone(), ttl - 1, seen.clone())?;
        if let Some(conn) = self.pool.get(&peer).await {
            let _ = send_publish_rpc(&conn, payload).await;
        }
    }
    // Also emit IHAVE to D_lazy gossip peers.
    let gossip_peers = r.select_gossip_peers(&topic);
    for peer in gossip_peers {
        // piggyback IHAVE control message on next frame
    }
} else {
    // Fallback: floodsub (backward compat if gossip not configured).
    let peers = self.remote_subscribers(&topic);
    // ... existing floodsub logic ...
}
```

## Constraints

1. **No wire protocol changes.** GossipSub control messages (IHAVE/IWANT/
   GRAFT/PRUNE) are encoded as CBOR in the existing `PublishParams.seen` field
   or as a new RPC method `aafp.pubsub.gossip` (RFC-0009 amendment, optional).
   The publish frame structure is unchanged.

2. **Backward compatibility.** If `GossipSubRouter` is not configured, the
   handler falls back to floodsub. ACLs default to `allow_all` (matches
   RFC-0009 §5). Existing tests must pass unchanged.

3. **UCAN integration.** Use `aafp_identity::ucan::UcanToken` and
   `Capability` as-is. Do not modify `ucan.rs`. The `caps_compatible()`
   function already supports sub-resource matching (`compute.inference` is
   compatible with `compute`), which works for `pubsub/tasks.*` ⊆ `pubsub`.

4. **Follow existing conventions.** Check `AGENTS.md` for build/test
   commands. Use `cargo fmt`, `cargo clippy`, `cargo test --workspace`.

5. **Add tests for every feature.** Target: 1700+ tests (currently 1597).

## Verification

```bash
cargo fmt --all -- --check   # 0 diffs
cargo build --workspace       # 0 errors, 0 warnings
cargo clippy --workspace      # 0 warnings
cargo test --workspace        # 1700+ tests, 0 failures
```

## Files to Modify

| File | Changes |
|------|---------|
| `crates/aafp-messaging/src/pubsub_acl.rs` | NEW: TopicAcl, PubSubCapability, AclAuthorizationProvider |
| `crates/aafp-messaging/src/gossipsub.rs` | NEW: GossipSubRouter, GossipSubConfig, PeerScore, mesh, heartbeat |
| `crates/aafp-messaging/src/pubsub_v1.rs` | ConnectionLimits, ConnectionState, PubSubError codes, ACL hooks, gossip router integration |
| `crates/aafp-messaging/src/lib.rs` | Re-export new types |
| `crates/aafp-sdk/src/simple.rs` | `.with_acl()`, `.with_gossipsub()`, `.with_connection_limits()` builder methods |
| `crates/aafp-sdk/src/pubsub_bridge.rs` | Wire ACL + gossip config into ServingAgent |
| `crates/aafp-messaging/tests/` | ACL tests, gossip mesh tests, peer scoring tests, limit enforcement tests |

## Success Criteria

- [ ] `PubSubCapability::parse("pubsub/tasks.*/subscribe")` succeeds
- [ ] `TopicAcl::check()` grants authorized publish/subscribe, denies unauthorized
- [ ] `AclAuthorizationProvider` implements `AuthorizationProvider` trait
- [ ] Publish authorization returns error 9007 when denied
- [ ] Subscribe authorization returns error 9008 when denied or limit exceeded
- [ ] `ConnectionLimits` enforces max_subscriptions, max_publish_rate, max_message_size
- [ ] Error 9009 returned when publish rate exceeded
- [ ] Error 9010 returned when message too large
- [ ] Error 9006 returned for malformed/missing topic
- [ ] `GossipSubConfig` with D=6, D_lo=4, D_hi=12, D_lazy=6 defaults
- [ ] `maintain_mesh()` grafts peers when below D_lo, prunes when above D_hi
- [ ] `PeerScore` with 7 parameters computes total score
- [ ] `should_prune()` returns true for peers below prune_threshold
- [ ] `heartbeat_loop()` runs mesh maintenance + score decay periodically
- [ ] IHAVE/IWANT gossip control messages encode/decode via CBOR
- [ ] Fallback to floodsub when gossip router not configured
- [ ] All existing tests pass (1597+)
- [ ] New tests for ACL, gossip, scoring, limits (target 1700+ total)
- [ ] `cargo clippy` clean
- [ ] `cargo fmt` clean
