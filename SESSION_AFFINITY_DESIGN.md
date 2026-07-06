# Session Affinity and Connection Reuse Design for AAFP Simple API

## Executive Summary

The AAFP Simple API currently performs a fresh QUIC dial + ML-DSA-65 handshake for every `discover().call()` operation, resulting in significant performance overhead. This document presents a comprehensive design for integrating connection pooling and session affinity into the Simple API, leveraging the existing `ConnectionPool` infrastructure. The proposed design reduces the per-call cost from ~709us (full handshake) to ~14us (stream open on existing connection) — a **50x improvement**.

## 1. Analysis of Existing ConnectionPool

### 1.1 Current API

The existing `ConnectionPool` (crates/aafp-sdk/src/connection_pool.rs) provides:

```rust
pub struct ConnectionPool {
    connections: Mutex<HashMap<AgentId, PooledConnection>>,
    config: PoolConfig,
    auth_provider: Arc<dyn AuthorizationProvider>,
}

pub struct PooledConnection {
    conn: QuicConnection,
    session: Session,
    last_used: Instant,
    addr: String,
}
```

**Key Methods:**
- `get_or_connect(agent, addr) -> Result<(AgentId, QuicConnection), SdkError>` - Get existing or create new
- `release(peer_id)` - Mark connection as available for reuse
- `remove(peer_id)` - Remove and close a connection
- `evict_idle()` - Remove idle connections (default 60s timeout)
- `len()`, `is_empty()`, `peers()` - Pool inspection

**Configuration:**
```rust
pub struct PoolConfig {
    pub max_size: usize,           // Default: 100
    pub idle_timeout: Duration,    // Default: 60s
}
```

**Health Check Strategy:**
- Connections idle for >5s are health-checked via `open_bi()` before reuse
- Recently-used connections (<5s idle) skip health check (assumed healthy)
- Failed health checks trigger connection removal and re-establishment

### 1.2 Why Simple API Doesn't Use It

The Simple API's `call_agent()` function (simple.rs:460-521) directly calls:

```rust
let conn = agent.transport.dial(addr).await?;
let auth = Arc::new(TestingAuthProvider);
let (_session, conn, _peer_info) = establish_session(conn, &agent.keypair, auth, true, None).await?;
```

**Root Causes:**
1. **No pool reference**: `ConnectedAgent` doesn't hold a `ConnectionPool`
2. **No integration point**: `call_agent()` is a standalone function with no access to pool state
3. **Simple API design philosophy**: The simple API was designed for ease-of-use, not performance optimization
4. **Session state not tracked**: The simple API discards the `Session` after handshake (assigned to `_session`)

### 1.3 Current Performance Impact

Based on PERFORMANCE_REPORT.md:
- **ML-DSA-65 handshake**: 709us (full PQ handshake)
- **Stream open on existing connection**: ~14us (connection_pool.rs:6)
- **Improvement factor**: 50x

**Real-world impact:**
- 5-step agent chain: 5 x 709us = **3.5ms** vs 5 x 14us = **70us**
- Polling-based progress check (10 polls): 10 x 709us = **7.1ms** vs 10 x 14us = **140us**
- Multi-turn conversation (20 turns): 20 x 709us = **14.2ms** vs 20 x 14us = **280us**

## 2. Proposed Simple API Integration

### 2.1 Architecture Overview

```text
ConnectedAgent
    |
    +-- agent: SdkAgent (existing)
    +-- pool: Arc<ConnectionPool> (NEW)
            |
            +-- connections: HashMap<AgentId, PooledConnection>
            |   +-- PooledConnection { conn, session, last_used, addr }
            |
            +-- config: PoolConfig
```

### 2.2 Modified ConnectedAgent

```rust
pub struct ConnectedAgent {
    agent: SdkAgent,
    pool: Arc<ConnectionPool>,  // NEW: Internal connection pool
}

impl ConnectedAgent {
    pub async fn call_at(&self, addr: &str, request: Request) -> Result<Response, SdkError> {
        call_agent_with_pool(&self.agent, &self.pool, addr, request).await
    }
}
```

### 2.3 Modified ConnectBuilder

```rust
pub struct ConnectBuilder {
    keypair: Option<AgentKeypair>,
    seeds: Vec<String>,
    pool_config: PoolConfig,  // NEW: Configurable pool settings
}

impl ConnectBuilder {
    /// Set connection pool configuration.
    pub fn with_pool_config(mut self, config: PoolConfig) -> Self {
        self.pool_config = config;
        self
    }

    pub async fn connect(self) -> Result<ConnectedAgent, SdkError> {
        let mut builder = AgentBuilder::new();
        if let Some(kp) = self.keypair {
            builder = builder.with_keypair(kp);
        }
        if !self.seeds.is_empty() {
            builder = builder.with_seeds(self.seeds);
        }
        let agent = builder.build().await?;

        // NEW: Create connection pool
        let pool = Arc::new(ConnectionPool::new(self.pool_config));

        Ok(ConnectedAgent { agent, pool })
    }
}
```

### 2.4 Modified call_agent Function

```rust
async fn call_agent_with_pool(
    agent: &SdkAgent,
    pool: &ConnectionPool,
    addr: &str,
    request: Request,
) -> Result<Response, SdkError> {
    // Use pool instead of direct dial
    let (peer_id, conn) = pool.get_or_connect(agent, addr).await?;

    // Encode request as RPC (existing code)
    let params = if !request.body().is_empty() {
        Value::TextString(request.body().to_string())
    } else if let Some(data) = request.payload() {
        Value::ByteString(data.to_vec())
    } else {
        Value::TextString(String::new())
    };
    let rpc_req = RpcRequest::new(1, "call").with_params(params);
    let rpc_bytes = rpc_req
        .encode()
        .map_err(|e| SdkError::Messaging(e.to_string()))?;

    // Send request frame (existing code)
    let (mut send, mut recv) = conn.open_bi().await?;
    let frame = Frame::data(0, rpc_bytes);
    let frame_bytes = encode_frame(&frame)?;
    send.write_all(&frame_bytes).await?;
    send.finish();

    // Read response frame (existing code)
    let mut header = [0u8; FRAME_HEADER_SIZE];
    recv.read_exact(&mut header).await?;
    let payload_len = u64::from_be_bytes(header[12..20].try_into().unwrap()) as usize;
    let ext_len = u64::from_be_bytes(header[20..28].try_into().unwrap()) as usize;
    let body_len = payload_len + ext_len;
    let mut body = vec![0u8; body_len];
    if body_len > 0 {
        recv.read_exact(&mut body).await?;
    }
    let mut full_frame = header.to_vec();
    full_frame.extend_from_slice(&body);
    let (resp_frame, _) = decode_frame(&full_frame)?;

    // Decode RPC response (existing code)
    let rpc_resp =
        RpcResponse::decode(&resp_frame.payload).map_err(|e| SdkError::Messaging(e.to_string()))?;

    if !rpc_resp.is_success() {
        let msg = rpc_resp
            .error
            .map(|e| e.message)
            .unwrap_or_else(|| "unknown error".to_string());
        return Err(SdkError::Messaging(msg));
    }

    // Convert to simple Response (existing code)
    let response = match &rpc_resp.result {
        Some(Value::TextString(s)) => Response::text(s.clone()),
        Some(Value::ByteString(b)) => Response::data(b.clone()),
        _ => Response::text(String::new()),
    };

    // Release connection back to pool
    pool.release(&peer_id).await;

    Ok(response)
}
```

### 2.5 Backward Compatibility

The changes are **fully backward compatible**:
- Default `PoolConfig` provides sensible defaults (max_size=100, idle_timeout=60s)
- Existing code using `Agent::connect().connect().await?` continues to work
- New `with_pool_config()` method is optional
- Pool is internal to `ConnectedAgent` — no API surface changes for users

## 3. Session Affinity Design

### 3.1 Session Identification

**Session ID Derivation** (from handshake_v1.rs:343-362):

```rust
pub fn derive_session_id(
    h_after_clienthello: &[u8; 32],
    client_nonce: &[u8; NONCE_SIZE],
    server_nonce: &[u8; NONCE_SIZE],
    server_agent_id: &[u8; 32],
) -> [u8; SESSION_ID_SIZE] {
    // ikm = h_after_clienthello || server_agent_id
    // prk = HKDF-Extract(salt = client_nonce || server_nonce, IKM = ikm)
    // session_id = HKDF-Expand(prk, info = "aafp-session-id-v1", L = 32)
}
```

**Key Properties:**
- 32-byte cryptographically derived from handshake transcript
- Bound to server's AgentId (prevents session fixation)
- Unique per handshake (nonces are random)
- Available in `Session.session_id()` after `IdentityVerified` state

### 3.2 Session Affinity Routing Strategy

**Approach 1: Connection-Level Affinity (Recommended)**

Route all requests for the same peer AgentId to the same QUIC connection:

```rust
// In ConnectionPool
pub async fn get_or_connect(
    &self,
    agent: &Agent,
    addr: &str,
) -> Result<(AgentId, QuicConnection, SessionId), SdkError> {
    let mut conns = self.connections.lock().await;
    self.evict_idle_locked(&mut conns);

    // Check by address (maps to peer AgentId after first connection)
    let existing_peer_id = conns
        .iter()
        .find(|(_, pc)| pc.addr == addr)
        .map(|(id, _)| *id);

    if let Some(peer_id) = existing_peer_id {
        if let Some(pc) = conns.get_mut(&peer_id) {
            // Health check and reuse
            if Self::is_healthy(&pc.conn).await {
                pc.last_used = Instant::now();
                let session_id = pc.session.session_id()
                    .expect("session should have ID after handshake");
                return Ok((peer_id, pc.conn.clone(), *session_id));
            } else {
                conns.remove(&peer_id);
            }
        }
    }

    // Create new connection
    drop(conns);
    let conn = agent.transport.dial(addr).await?;
    let (session, conn, peer_info) =
        establish_session(conn, &agent.keypair, self.auth_provider.clone(), true, None).await?;

    let peer_id = peer_info.agent_id;
    let session_id = peer_info.session_id;

    // Store in pool
    let mut conns = self.connections.lock().await;
    self.evict_idle_locked(&mut conns);

    if conns.len() >= self.config.max_size {
        // Evict oldest
        if let Some(oldest_id) = conns
            .iter()
            .min_by_key(|(_, pc)| pc.last_used)
            .map(|(id, _)| *id)
        {
            if let Some(removed) = conns.remove(&oldest_id) {
                removed.conn.close(0, b"pool eviction");
            }
        }
    }

    conns.insert(
        peer_id,
        PooledConnection {
            conn: conn.clone(),
            session,
            last_used: Instant::now(),
            addr: addr.to_string(),
        },
    );

    Ok((peer_id, conn, session_id))
}
```

**Approach 2: Application-Level Session ID (Optional Enhancement)**

For scenarios where multiple logical sessions exist per peer (e.g., multi-tenant server):

```rust
pub struct Request {
    text: String,
    data: Option<Vec<u8>>,
    session_id: Option<SessionId>,  // NEW: Optional session affinity hint
}

impl Request {
    pub fn with_session_id(mut self, session_id: SessionId) -> Self {
        self.session_id = Some(session_id);
        self
    }
}
```

**Routing Logic:**
```rust
// In call_agent_with_pool
let session_hint = request.session_id;
let (peer_id, conn, actual_session_id) = if let Some(sid) = session_hint {
    // Try to find connection with matching session_id
    pool.get_by_session(agent, addr, sid).await?
} else {
    // Default: route by peer AgentId
    pool.get_or_connect(agent, addr).await?
};
```

### 3.3 Session Lifecycle

**Connection Lifecycle:**
```
Created (dial + handshake)
    |
Active (in pool, last_used updated on each call)
    |
Idle (no calls for >60s)
    |
Evicted (connection closed, removed from pool)
```

**Session State Lifecycle** (from session.rs):
```
Connecting -> TransportEstablished -> IdentityVerified ->
AuthorizationVerified -> Authenticated -> MessagingEnabled ->
Closing -> Closed
```

**Pool Management:**
- **Creation**: On first call to a peer
- **Reuse**: On subsequent calls to same peer (if healthy)
- **Health check**: Every 5s of idle time (configurable via `HEALTH_CHECK_THRESHOLD`)
- **Eviction**: After 60s idle (configurable via `PoolConfig.idle_timeout`)
- **Capacity**: Max 100 connections per pool (configurable via `PoolConfig.max_size`)
- **Manual removal**: Via `pool.remove(peer_id)` for explicit cleanup

## 4. Server-Side Session State Design

### 4.1 Session State Storage

**Option 1: In-Memory HashMap (Simple)**

```rust
pub struct SessionManager {
    sessions: Arc<Mutex<HashMap<SessionId, SessionState>>>,
}

pub struct SessionState {
    peer_agent_id: AgentId,
    created_at: Instant,
    last_activity: Instant,
    custom_data: HashMap<String, Vec<u8>>,  // User-defined state
}

impl SessionManager {
    pub fn get_or_create(&self, session_id: SessionId, peer_id: AgentId) -> SessionState {
        let mut sessions = self.sessions.lock().unwrap();
        sessions.entry(session_id).or_insert_with(|| SessionState {
            peer_agent_id: peer_id,
            created_at: Instant::now(),
            last_activity: Instant::now(),
            custom_data: HashMap::new(),
        }).clone()
    }

    pub fn update(&self, session_id: SessionId, key: String, value: Vec<u8>) {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(state) = sessions.get_mut(&session_id) {
            state.custom_data.insert(key, value);
            state.last_activity = Instant::now();
        }
    }

    pub fn evict_idle(&self, timeout: Duration) -> usize {
        let mut sessions = self.sessions.lock().unwrap();
        let now = Instant::now();
        let to_evict: Vec<SessionId> = sessions
            .iter()
            .filter(|(_, s)| now.duration_since(s.last_activity) > timeout)
            .map(|(id, _)| *id)
            .collect();
        for id in to_evict {
            sessions.remove(&id);
        }
        to_evict.len()
    }
}
```

**Option 2: Persistent Storage (Production)**

```rust
pub trait SessionStore: Send + Sync {
    fn get(&self, session_id: SessionId) -> Option<SessionState>;
    fn set(&self, session_id: SessionId, state: SessionState);
    fn delete(&self, session_id: SessionId);
    fn evict_idle(&self, timeout: Duration) -> usize;
}

// SQLite implementation
pub struct SqliteSessionStore {
    db: Arc<Mutex<rusqlite::Connection>>,
}
```

### 4.2 Integration with Simple API

**Modified ServeBuilder:**

```rust
pub struct ServeBuilder {
    capabilities: Vec<String>,
    handler: Option<HandlerFn>,
    bind_addr: Option<SocketAddr>,
    keypair: Option<AgentKeypair>,
    metrics_addr: Option<SocketAddr>,
    session_manager: Option<Arc<SessionManager>>,  // NEW
}

impl ServeBuilder {
    /// Enable session state management.
    pub fn with_session_manager(mut self, manager: Arc<SessionManager>) -> Self {
        self.session_manager = Some(manager);
        self
    }
}
```

### 4.3 Session-Aware Handlers

**Enhanced Handler Signature:**

```rust
pub type SessionAwareHandlerFn = Arc<
    dyn Fn(Request, SessionContext) -> Pin<Box<dyn Future<Output = Result<Response, String>> + Send>> + Send + Sync,
>;

pub struct SessionContext {
    pub session_id: SessionId,
    pub peer_agent_id: AgentId,
    pub created_at: Instant,
    pub last_activity: Instant,
}

impl ServeBuilder {
    /// Set a session-aware request handler.
    pub fn session_handler<F, Fut>(mut self, f: F) -> Self
    where
        F: Fn(Request, SessionContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Response, String>> + Send + 'static,
    {
        self.session_handler = Some(Arc::new(move |req, ctx| Box::pin(f(req, ctx))));
        self
    }
}
```

## 5. Connection Pool Management Strategy

### 5.1 Pool Configuration

**Default Configuration:**
```rust
pub const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
pub const DEFAULT_MAX_POOL_SIZE: usize = 100;
pub const HEALTH_CHECK_THRESHOLD: Duration = Duration::from_secs(5);
```

**Recommended Tuning:**
- **High-throughput scenarios**: Increase `max_size` to 500-1000
- **Low-latency scenarios**: Reduce `idle_timeout` to 30s to free resources faster
- **Resource-constrained environments**: Reduce `max_size` to 20-50

### 5.2 Health Check Strategy

**Current Implementation** (connection_pool.rs:332-347):
```rust
async fn is_healthy(conn: &QuicConnection) -> bool {
    match conn.open_bi().await {
        Ok((_send, _recv)) => true,
        Err(_) => false,
    }
}
```

### 5.3 Eviction Policy

**LRU Eviction** (current):
```rust
if conns.len() >= self.config.max_size {
    if let Some(oldest_id) = conns
        .iter()
        .min_by_key(|(_, pc)| pc.last_used)
        .map(|(id, _)| *id)
    {
        if let Some(removed) = conns.remove(&oldest_id) {
            removed.conn.close(0, b"pool eviction");
        }
    }
}
```

### 5.4 Metrics Integration

**Pool Metrics** (extend AgentMetrics):
```rust
pub struct AgentMetrics {
    // ... existing metrics ...

    // Connection pool metrics
    pub pool_size: AtomicU64,
    pub pool_hits: AtomicU64,
    pub pool_misses: AtomicU64,
    pub pool_evictions: AtomicU64,
    pub pool_health_checks: AtomicU64,
}
```

## 6. Performance Analysis

### 6.1 Handshake Cost Breakdown

Based on PERFORMANCE_REPORT.md and handshake benchmarks:

| Operation | Time | Notes |
|-----------|------|-------|
| ML-DSA-65 keygen | 133 us | One-time per agent |
| ML-DSA-65 sign | 272 us | Per handshake (client + server) |
| ML-DSA-65 verify | 76 us | Per handshake (client + server) |
| Full PQ handshake | 709 us | ClientHello + ServerHello + ClientFinished |
| QUIC dial | ~100-200 us | TLS 1.3 + X25519MLKEM768 KEX |
| Stream open (existing conn) | ~14 us | Just QUIC stream creation |
| **Total with connection reuse** | **~14 us** | **50x improvement** |

### 6.2 Expected Latency Improvement

**Scenario 1: 5-step agent chain**
- Without pooling: 5 x 709us = **3.5ms**
- With pooling: 1 x 709us + 4 x 14us = **765us**
- **Improvement: 4.6x**

**Scenario 2: Polling-based progress check (10 polls)**
- Without pooling: 10 x 709us = **7.1ms**
- With pooling: 1 x 709us + 9 x 14us = **835us**
- **Improvement: 8.5x**

**Scenario 3: Multi-turn conversation (20 turns)**
- Without pooling: 20 x 709us = **14.2ms**
- With pooling: 1 x 709us + 19 x 14us = **975us**
- **Improvement: 14.6x**

**Scenario 4: Repeated calls to same agent (100 calls)**
- Without pooling: 100 x 709us = **70.9ms**
- With pooling: 1 x 709us + 99 x 14us = **2.1ms**
- **Improvement: 33.8x**

### 6.3 Memory Overhead

**Per-connection overhead:**
- `QuicConnection`: ~1KB (Arc wrapper around quinn::Connection)
- `Session`: 168 bytes (from session.rs)
- `PooledConnection` metadata: ~200 bytes
- **Total per connection**: ~1.4KB

**Pool memory usage:**
- Default max_size=100: 100 x 1.4KB = **140KB**
- Max size=1000: 1000 x 1.4KB = **1.4MB**
- **Acceptable overhead** for typical deployments

## 7. Comparison with gRPC/Tonic Connection Management

### 7.1 gRPC Connection Pooling

**gRPC Architecture** (from grpc.github.io):
- gRPC uses HTTP/2 with persistent connections
- Single HTTP/2 connection per endpoint
- Multiple RPCs multiplexed over the same connection
- Connection pool managed by the channel layer
- Health checks via HTTP/2 PING frames
- GOAWAY frame signals connection shutdown

### 7.2 Tonic (Rust gRPC) Connection Management

**Key Characteristics:**
- **Cheap Clone**: `Channel` is cheap to clone (Arc-based)
- **Backpressure**: Uses `tower::Service::poll_ready` for flow control
- **Multiplexing**: Multiple RPCs via cloned channels
- **No explicit pool**: Single connection per endpoint by default

**Comparison with AAFP:**

| Feature | gRPC/Tonic | AAFP (proposed) |
|---------|------------|-----------------|
| Transport | HTTP/2 | QUIC |
| Multiplexing | HTTP/2 streams | QUIC bidirectional streams |
| Connection pooling | Implicit (channel) | Explicit (ConnectionPool) |
| Health checks | HTTP/2 PING | QUIC stream open |
| Session affinity | Not applicable | Session ID-based |
| Post-quantum | No | Yes (ML-DSA-65) |

### 7.3 Lessons from gRPC

**Adopted patterns:**
1. **Persistent connections**: Reuse connections for multiple RPCs
2. **Health checks**: Periodic liveness probes
3. **Graceful shutdown**: Notify peers before closing
4. **Backpressure**: Respect stream limits

**AAFP-specific enhancements:**
1. **Session affinity**: Cryptographic session IDs for routing
2. **Post-quantum security**: ML-DSA-65 signatures
3. **Explicit pool control**: Configurable pool size and timeout
4. **Session state**: Server-side session state management

## 8. Concrete Rust API Designs

### 8.1 Client-Side API

**Basic Usage (backward compatible):**
```rust
use aafp_sdk::simple::{Agent, Request};

async fn example() -> Result<(), Box<dyn std::error::Error>> {
    let agent = Agent::connect().connect().await?;

    // First call: establishes connection (709us)
    let result = agent.discover("echo")
        .call(Request::text("hello"))
        .await?;

    // Second call: reuses connection (14us)
    let result2 = agent.discover("echo")
        .call(Request::text("world"))
        .await?;

    Ok(())
}
```

**Advanced Usage (with pool config):**
```rust
use aafp_sdk::simple::{Agent, Request};
use aafp_sdk::{PoolConfig, DEFAULT_IDLE_TIMEOUT};

async fn example() -> Result<(), Box<dyn std::error::Error>> {
    let agent = Agent::connect()
        .with_pool_config(PoolConfig {
            max_size: 500,
            idle_timeout: Duration::from_secs(30),
        })
        .connect()
        .await?;

    // ... calls use configured pool ...

    Ok(())
}
```

### 8.2 Server-Side API

**Basic Usage (backward compatible):**
```rust
use aafp_sdk::simple::{Agent, Request, Response};

async fn example() -> Result<(), Box<dyn std::error::Error>> {
    Agent::serve()
        .capability("echo")
        .handler(|req: Request| async move {
            Ok(Response::text(req.body()))
        })
        .start()
        .await?;

    Ok(())
}
```

**Session-Aware Usage (future):**
```rust
use aafp_sdk::simple::{Agent, Request, Response, SessionContext};

async fn example() -> Result<(), Box<dyn std::error::Error>> {
    let session_manager = Arc::new(SessionManager::new());

    Agent::serve()
        .capability("echo")
        .with_session_manager(session_manager.clone())
        .session_handler(|req: Request, ctx: SessionContext| async move {
            // Access session state
            let state = session_manager.get_or_create(ctx.session_id, ctx.peer_agent_id);

            // Update state
            session_manager.update(ctx.session_id, "last_call".to_string(), vec![]);

            Ok(Response::text(req.body()))
        })
        .start()
        .await?;

    Ok(())
}
```

### 8.3 Pool Inspection API

```rust
impl ConnectedAgent {
    /// Get connection pool statistics.
    pub fn pool_stats(&self) -> PoolStats {
        PoolStats {
            size: self.pool.len().await,
            max_size: self.pool.config().max_size,
            idle_timeout: self.pool.config().idle_timeout,
            peers: self.pool.peers().await,
        }
    }
}

pub struct PoolStats {
    pub size: usize,
    pub max_size: usize,
    pub idle_timeout: Duration,
    pub peers: Vec<AgentId>,
}
```

## 9. Session Persistence Across Restarts

### 9.1 Checkpointing Session State

**Session State Serialization:**
```rust
#[derive(Serialize, Deserialize)]
pub struct CheckpointedSession {
    pub session_id: SessionId,
    pub peer_agent_id: AgentId,
    pub created_at: u64,  // Unix timestamp
    pub last_activity: u64,
    pub custom_data: HashMap<String, Vec<u8>>,
}
```

### 9.2 Limitations

**Session ID Binding:**
- Session IDs are cryptographically bound to handshake transcript
- Cannot restore exact session after restart (nonces change)
- **Workaround**: Restore only custom data, map to new session IDs via application logic

**Connection State:**
- QUIC connections cannot persist across process restarts
- Must re-establish connections on startup
- Session affinity re-establishes after first call

## 10. Multi-Agent Session Sharing

### 10.1 UCAN Delegation for Sessions

**Session Delegation UCAN:**
```rust
// Agent A delegates session access to Agent C
let session_capability = Capability {
    resource: format!("session.{}", hex::encode(session_id)),
    action: "access".into(),
    constraints: Some(serde_json::json!({
        "expires_at": expires_at,
    })),
};

let delegation_token = UcanToken::delegate_with_proof(
    &agent_a_keypair,
    &agent_c_id,
    vec![session_capability],
    expires_at,
    &parent_token,  // Optional: chain from root
)?;
```

### 10.2 Delegation Flow

```text
Agent A (session owner)
    |
    +-- Creates session with Agent B
    |   +-- session_id = derive_session_id(...)
    |
    +-- Mints UCAN token for Agent C
    |   +-- cap = "session.{session_id}/access"
    |
    +-- Sends UCAN token to Agent C

Agent C (delegatee)
    |
    +-- Receives UCAN token from Agent A
    |
    +-- Calls Agent B with UCAN token
    |   +-- Request::with_delegation(token)
    |
    +-- Agent B verifies UCAN chain
        +-- Grants access to session state
```

### 10.3 API Integration

**Request with Delegation:**
```rust
pub struct Request {
    text: String,
    data: Option<Vec<u8>>,
    session_id: Option<SessionId>,
    delegation: Option<UcanToken>,  // NEW
}

impl Request {
    pub fn with_delegation(mut self, token: UcanToken) -> Self {
        self.delegation = Some(token);
        self
    }
}
```

## 11. Implementation Plan

### 11.1 Phase 1: Basic Connection Pooling (Week 1-2)

**Tasks:**
1. Add `pool: Arc<ConnectionPool>` to `ConnectedAgent`
2. Add `pool_config: PoolConfig` to `ConnectBuilder`
3. Add `with_pool_config()` method to `ConnectBuilder`
4. Modify `call_agent()` to `call_agent_with_pool()`
5. Update `DiscoveryBuilder::call()` to use pool
6. Add unit tests for pool integration

### 11.2 Phase 2: Session Affinity (Week 3)

**Tasks:**
1. Return `SessionId` from `ConnectionPool::get_or_connect()`
2. Add `session_id: Option<SessionId>` to `Request`
3. Add `with_session_id()` method to `Request`
4. Implement session-aware routing in pool
5. Add session affinity tests

### 11.3 Phase 3: Server-Side Session State (Week 4)

**Tasks:**
1. Implement `SessionManager` with in-memory storage
2. Add `session_manager: Option<Arc<SessionManager>>` to `ServeBuilder`
3. Add `with_session_manager()` method to `ServeBuilder`
4. Extract session ID from handshake in serve loop
5. Register sessions in manager
6. Add session state tests

### 11.4 Phase 4: UCAN Delegation (Week 5-6)

**Tasks:**
1. Add `delegation: Option<UcanToken>` to `Request`
2. Add `with_delegation()` method to `Request`
3. Implement `UcanVerifier` trait
4. Add UCAN verification to `SessionManager`
5. Implement delegation flow tests
6. Document delegation security model

### 11.5 Phase 5: Metrics and Monitoring (Week 7)

**Tasks:**
1. Extend `AgentMetrics` with pool metrics
2. Add metrics collection to `ConnectionPool`
3. Implement `PoolStats` API
4. Add Prometheus metrics for pool
5. Add metrics tests

## 12. Security Considerations

### 12.1 Session ID Security

**Binding to AgentId:**
- Session IDs are bound to server's AgentId (handshake_v1.rs:343-362)
- Prevents session fixation attacks
- Ensures session IDs cannot be forged

**Cryptographic Derivation:**
- HKDF-based derivation from handshake transcript
- Nonces ensure uniqueness per handshake
- Domain separator "aafp-session-id-v1" prevents cross-protocol reuse

### 12.2 Connection Pool Security

**Session State Isolation:**
- Each connection has its own `Session` object
- Session state is not shared across connections
- Authorization context is per-session

**Pool Eviction:**
- Idle connections are closed cleanly
- Session state is evicted with connection
- No stale session state persists

### 12.3 UCAN Delegation Security

**Chain Verification:**
- UCAN chains are verified end-to-end
- Capabilities cannot expand (ucan.rs:306-313)
- Expiration is enforced
- Parent hash linkage prevents tampering

### 12.4 Replay Protection

**Replay Cache** (aafp-crypto::replay_cache):
- Nonces are cached and checked before signature verification
- Time-bounded (default 300s retention)
- LRU eviction (default 100K entries)
- Integrated into handshake driver

## 13. Conclusion

This design provides a comprehensive solution for session affinity and connection reuse in the AAFP Simple API. The key benefits are:

1. **50x performance improvement** for repeated calls to the same agent
2. **Backward-compatible API** with optional configuration
3. **Session affinity** via cryptographic session IDs
4. **Server-side session state** for stateful interactions
5. **UCAN delegation** for multi-agent session sharing
6. **Production-ready** with metrics, monitoring, and security considerations

The implementation is phased to allow incremental delivery, starting with basic connection pooling and progressively adding session affinity, session state, and delegation features. The design leverages existing infrastructure (ConnectionPool, Session, UCAN) and follows AAFP's security and performance requirements.

## Appendix A: Key File References

- **`crates/aafp-sdk/src/simple.rs`** - Simple API implementation (lines 460-521: call_agent)
- **`crates/aafp-sdk/src/connection_pool.rs`** - Connection pool implementation
- **`crates/aafp-sdk/src/transport_binding.rs`** - Session establishment
- **`crates/aafp-sdk/src/handshake_driver.rs`** - Handshake driver (lines 216-321: client, 332-438: server)
- **`crates/aafp-core/src/session.rs`** - Session state machine
- **`crates/aafp-crypto/src/handshake_v1.rs`** - Session ID derivation (lines 343-362)
- **`crates/aafp-identity/src/ucan.rs`** - UCAN delegation tokens
- **`crates/aafp-transport-quic/src/transport.rs`** - QUIC transport
- **`PERFORMANCE_REPORT.md`** - Performance benchmarks

## Appendix B: Performance Benchmarks

Based on PERFORMANCE_REPORT.md and connection_pool.rs:

| Operation | Time | Improvement |
|-----------|------|-------------|
| Full handshake (dial + ML-DSA-65) | 709 us | Baseline |
| Stream open on existing connection | 14 us | 50x faster |
| 5-step chain (no pool) | 3.5 ms | Baseline |
| 5-step chain (with pool) | 765 us | 4.6x faster |
| 100 calls (no pool) | 70.9 ms | Baseline |
| 100 calls (with pool) | 2.1 ms | 33.8x faster |

## Appendix C: Configuration Reference

**PoolConfig:**
```rust
pub struct PoolConfig {
    pub max_size: usize,           // Default: 100
    pub idle_timeout: Duration,    // Default: 60s
}
```

**Constants:**
```rust
pub const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
pub const DEFAULT_MAX_POOL_SIZE: usize = 100;
pub const HEALTH_CHECK_THRESHOLD: Duration = Duration::from_secs(5);
```

**Recommended Tuning:**
- High-throughput: `max_size=500-1000`, `idle_timeout=30s`
- Low-latency: `max_size=100`, `idle_timeout=30s`
- Resource-constrained: `max_size=20-50`, `idle_timeout=60s`
