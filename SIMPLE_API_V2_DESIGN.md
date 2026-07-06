# AAFP Simple API v2 Design

**Status:** Design Document
**Date:** 2025-01-15
**Target:** crates/aafp-sdk/src/simple.rs
**RFC References:** RFC-0002 (Transport), RFC-0003 (Identity), RFC-0005 (Error Model)

## Executive Summary

The current Simple API (v1) has 5 critical gaps confirmed by 8 sandbox tests:
1. No structured request/response (text XOR binary only)
2. Capability name not forwarded to handler
3. No streaming responses
4. No session affinity / connection reuse
5. No request metadata

Plus 5 additional gaps:
- One handler per ServeBuilder (no per-capability routing)
- No handler cancellation
- No response metadata
- No typed error codes (single 5000+string)
- DiscoveryBuilder borrows &SdkAgent (not 'static)
- discover() only tries [0], no failover

This design addresses ALL gaps while maintaining backward compatibility with existing P2.1-P2.5 code.

---

## 1. Structured Request/Response

### Problem
Current Request/Response hold text XOR binary, never both, never typed fields. CBOR Value::Map exists in the protocol but the simple API flattens it to a string. Every sandbox had to use JSON-in-text workarounds.

### Solution
Expose CBOR Map params directly via a new `Params` type that wraps `aafp_cbor::Value::IntMap`. Request and Response will carry both structured params AND optional text/binary payloads.

### Design

```rust
use aafp_cbor::Value;

/// Structured parameters (CBOR IntMap with integer keys).
#[derive(Debug, Clone)]
pub struct Params {
    inner: Value::IntMap,
}

impl Params {
    /// Create empty params.
    pub fn new() -> Self {
        Self { inner: Value::IntMap(vec![]) }
    }

    /// Add a string field.
    pub fn put_str(mut self, key: i64, value: impl Into<String>) -> Self {
        self.inner.0.push((key, Value::TextString(value.into())));
        self
    }

    /// Add a bytes field.
    pub fn put_bytes(mut self, key: i64, value: Vec<u8>) -> Self {
        self.inner.0.push((key, Value::ByteString(value)));
        self
    }

    /// Add an unsigned integer field.
    pub fn put_u64(mut self, key: i64, value: u64) -> Self {
        self.inner.0.push((key, Value::Unsigned(value)));
        self
    }

    /// Get a string field.
    pub fn get_str(&self, key: i64) -> Option<&str> {
        self.inner.0.iter()
            .find(|(k, _)| *k == key)
            .and_then(|(_, v)| match v {
                Value::TextString(s) => Some(s.as_str()),
                _ => None,
            })
    }

    /// Get a bytes field.
    pub fn get_bytes(&self, key: i64) -> Option<&[u8]> {
        self.inner.0.iter()
            .find(|(k, _)| *k == key)
            .and_then(|(_, v)| match v {
                Value::ByteString(b) => Some(b.as_slice()),
                _ => None,
            })
    }

    /// Get a u64 field.
    pub fn get_u64(&self, key: i64) -> Option<u64> {
        self.inner.0.iter()
            .find(|(k, _)| *k == key)
            .and_then(|(_, v)| match v {
                Value::Unsigned(n) => Some(*n),
                _ => None,
            })
    }

    /// Convert to CBOR Value.
    pub fn to_value(&self) -> Value {
        Value::IntMap(self.inner.0.clone())
    }

    /// Convert from CBOR Value.
    pub fn from_value(val: Value) -> Result<Self, String> {
        match val {
            Value::IntMap(entries) => Ok(Self { inner: Value::IntMap(entries) }),
            _ => Err("Params must be IntMap".to_string()),
        }
    }
}

impl Default for Params {
    fn default() -> Self {
        Self::new()
    }
}

/// Enhanced request with structured params, metadata, and optional text/binary.
#[derive(Debug, Clone)]
pub struct Request {
    /// Structured parameters (CBOR IntMap).
    pub params: Params,
    /// Optional text body (for backward compat / simple cases).
    pub text: String,
    /// Optional binary payload.
    pub data: Option<Vec<u8>>,
    /// Request metadata.
    pub metadata: RequestMetadata,
}

impl Request {
    /// Create a request with structured params.
    pub fn with_params(params: Params) -> Self {
        Self {
            params,
            text: String::new(),
            data: None,
            metadata: RequestMetadata::default(),
        }
    }

    /// Create a simple text request (backward compat).
    pub fn text(s: impl Into<String>) -> Self {
        Self {
            params: Params::new(),
            text: s.into(),
            data: None,
            metadata: RequestMetadata::default(),
        }
    }

    /// Create a binary data request.
    pub fn data(data: Vec<u8>) -> Self {
        Self {
            params: Params::new(),
            text: String::new(),
            data: Some(data),
            metadata: RequestMetadata::default(),
        }
    }

    /// Get the text body (backward compat).
    pub fn body(&self) -> &str {
        &self.text
    }

    /// Get the binary payload (backward compat).
    pub fn payload(&self) -> Option<&[u8]> {
        self.data.as_deref()
    }
}

/// Enhanced response with structured params, metadata, and optional text/binary.
#[derive(Debug, Clone)]
pub struct Response {
    /// Structured result (CBOR IntMap).
    pub result: Params,
    /// Optional text body (for backward compat).
    pub text: String,
    /// Optional binary payload.
    pub data: Option<Vec<u8>>,
    /// Response metadata.
    pub metadata: ResponseMetadata,
}

impl Response {
    /// Create a response with structured result.
    pub fn with_result(result: Params) -> Self {
        Self {
            result,
            text: String::new(),
            data: None,
            metadata: ResponseMetadata::default(),
        }
    }

    /// Create a simple text response (backward compat).
    pub fn text(s: impl Into<String>) -> Self {
        Self {
            result: Params::new(),
            text: s.into(),
            data: None,
            metadata: ResponseMetadata::default(),
        }
    }

    /// Create a binary data response.
    pub fn data(data: Vec<u8>) -> Self {
        Self {
            result: Params::new(),
            text: String::new(),
            data: Some(data),
            metadata: ResponseMetadata::default(),
        }
    }

    /// Get the text body (backward compat).
    pub fn body(&self) -> &str {
        &self.text
    }

    /// Get the binary payload (backward compat).
    pub fn payload(&self) -> Option<&[u8]> {
        self.data.as_deref()
    }
}
```

### Ergonomics
- Simple cases: `Request::text("hello")` still works (backward compat)
- Structured cases: `Request::with_params(Params::new().put_str(1, "name").put_u64(2, 42))`
- Mixed cases: Can have both params AND text/binary payload

### Wire Format
- RPC params field (key 3) carries the CBOR IntMap
- If params is empty and text is non-empty, encode as TextString (backward compat)
- If params is non-empty, encode as IntMap (new behavior)

---

## 2. Capability Forwarding

### Problem
call_agent hard-codes RpcRequest.method = "call". The capability used for DHT lookup is dropped. Handler can't tell which capability was invoked. Forces body-prefix dispatch hacks.

### Solution
Pass the capability name to the handler via RequestMetadata. Support both per-capability handlers (ServeBuilder::on_capability) and single handler with capability context.

### Design

```rust
/// Request metadata.
#[derive(Debug, Clone)]
pub struct RequestMetadata {
    /// The capability name being invoked.
    pub capability: String,
    /// Session ID (from handshake transcript).
    pub session_id: Option<[u8; 32]>,
    /// Trace ID for distributed tracing.
    pub trace_id: Option<String>,
    /// Request deadline (ISO 8601).
    pub deadline: Option<String>,
    /// Content type (for binary payloads).
    pub content_type: Option<String>,
}

impl Default for RequestMetadata {
    fn default() -> Self {
        Self {
            capability: String::new(),
            session_id: None,
            trace_id: None,
            deadline: None,
            content_type: None,
        }
    }
}

/// Handler context with cancellation token.
pub struct HandlerContext {
    /// Cancellation token (fires when client disconnects).
    pub cancel: tokio_util::sync::CancellationToken,
    /// The capability being invoked.
    pub capability: String,
}

/// Type alias for async handler functions (v2 with context).
pub type HandlerFnV2 = Arc<
    dyn Fn(Request, HandlerContext) -> Pin<Box<dyn Future<Output = Result<Response, SdkError>> + Send>> + Send + Sync,
>;

/// Type alias for per-capability handlers.
pub type CapabilityHandler = Arc<
    dyn Fn(Request, HandlerContext) -> Pin<Box<dyn Future<Output = Result<Response, SdkError>> + Send>> + Send + Sync,
>;

/// Builder for serving an agent (v2).
pub struct ServeBuilder {
    capabilities: Vec<String>,
    /// Per-capability handlers (new v2 feature).
    capability_handlers: HashMap<String, CapabilityHandler>,
    /// Fallback handler (for backward compat with v1).
    fallback_handler: Option<HandlerFnV2>,
    bind_addr: Option<SocketAddr>,
    keypair: Option<AgentKeypair>,
    metrics_addr: Option<SocketAddr>,
    /// Connection pool for outgoing calls (v2).
    connection_pool: Option<Arc<ConnectionPool>>,
}

impl ServeBuilder {
    /// Add a capability this agent provides.
    pub fn capability(mut self, cap: impl Into<String>) -> Self {
        self.capabilities.push(cap.into());
        self
    }

    /// Register a handler for a specific capability (v2).
    pub fn on_capability<F, Fut>(mut self, cap: impl Into<String>, f: F) -> Self
    where
        F: Fn(Request, HandlerContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Response, SdkError>> + Send + 'static,
    {
        let cap = cap.into();
        let handler = Arc::new(move |req: Request, ctx: HandlerContext| {
            Box::pin(f(req, ctx))
        });
        self.capability_handlers.insert(cap, handler);
        self
    }

    /// Set a fallback handler for all capabilities (v1 compat mode).
    pub fn handler<F, Fut>(mut self, f: F) -> Self
    where
        F: Fn(Request, HandlerContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Response, SdkError>> + Send + 'static,
    {
        let handler = Arc::new(move |req: Request, ctx: HandlerContext| {
            Box::pin(f(req, ctx))
        });
        self.fallback_handler = Some(handler);
        self
    }

    /// Enable connection pooling for outgoing calls (v2).
    pub fn with_connection_pool(mut self, pool: Arc<ConnectionPool>) -> Self {
        self.connection_pool = Some(pool);
        self
    }

    // ... other builder methods (bind, with_keypair, with_metrics) ...
}
```

### Handler Dispatch Logic
```rust
// In the request handling loop:
let capability = rpc_req.method.clone(); // Use method as capability name
let handler = self.capability_handlers.get(&capability)
    .cloned()
    .or_else(|| self.fallback_handler.clone());

if let Some(handler) = handler {
    let cancel_token = tokio_util::sync::CancellationToken::new();
    let ctx = HandlerContext {
        cancel: cancel_token.clone(),
        capability: capability.clone(),
    };

    // Update request metadata
    let mut request = request;
    request.metadata.capability = capability.clone();
    request.metadata.session_id = session.session_id().copied();

    tokio::select! {
        result = handler(request, ctx) => {
            // Handle result
        }
        _ = cancel_token.cancelled() => {
            // Client disconnected, abort handler
        }
    }
}
```

### Ergonomics
```rust
// v2: Per-capability handlers
Agent::serve()
    .capability("echo")
    .on_capability("echo", |req, ctx| async move {
        Ok(Response::text(req.body()))
    })
    .capability("sum")
    .on_capability("sum", |req, ctx| async move {
        let a = req.params.get_u64(1).unwrap_or(0);
        let b = req.params.get_u64(2).unwrap_or(0);
        Ok(Response::with_result(Params::new().put_u64(1, a + b)))
    })
    .start()
    .await?;

// v1 compat: Single handler
Agent::serve()
    .capability("echo")
    .handler(|req, ctx| async move {
        // Dispatch based on ctx.capability
        match ctx.capability.as_str() {
            "echo" => Ok(Response::text(req.body())),
            _ => Err(SdkError::Messaging("unknown capability".to_string())),
        }
    })
    .start()
    .await?;
```

---

## 3. Streaming API

### Problem
call_agent calls send.finish() immediately and reads exactly one response frame. QUIC bi-streams and the MORE flag exist but aren't exposed. Blocks: token streaming, progress push, partial results, heartbeats, SSE.

### Solution
Expose streaming via three handler signatures:
1. Unary (current): Request -> Response
2. Server-streaming: Request -> Stream<Response>
3. Bidirectional: Stream<Request> -> Stream<Response>

### Design

```rust
use tokio::sync::mpsc;

/// Streaming response sender.
pub struct ResponseSender {
    inner: mpsc::Sender<Result<Response, SdkError>>,
}

impl ResponseSender {
    /// Send a response frame.
    pub async fn send(&self, resp: Response) -> Result<(), SdkError> {
        self.inner.send(Ok(resp)).await
            .map_err(|_| SdkError::Messaging("channel closed".to_string()))
    }

    /// Send an error.
    pub async fn error(&self, err: SdkError) {
        let _ = self.inner.send(Err(err)).await;
    }

    /// Close the stream (no more responses).
    pub async fn close(self) {
        drop(self);
    }
}

/// Streaming response receiver.
pub struct ResponseStream {
    inner: mpsc::Receiver<Result<Response, SdkError>>,
}

impl ResponseStream {
    /// Receive the next response frame.
    pub async fn next(&mut self) -> Option<Result<Response, SdkError>> {
        self.inner.recv().await
    }
}

/// Handler mode (unary or streaming).
pub enum HandlerMode {
    /// Unary request/response.
    Unary,
    /// Server streaming (request -> stream of responses).
    ServerStreaming,
    /// Bidirectional streaming (stream of requests -> stream of responses).
    Bidirectional,
}

/// Streaming handler context.
pub struct StreamingHandlerContext {
    /// Cancellation token.
    pub cancel: tokio_util::sync::CancellationToken,
    /// The capability being invoked.
    pub capability: String,
    /// Response sender (for streaming handlers).
    pub sender: ResponseSender,
}

/// Type alias for server-streaming handler.
pub type ServerStreamingHandler = Arc<
    dyn Fn(Request, StreamingHandlerContext) -> Pin<Box<dyn Future<Output = Result<(), SdkError>> + Send>> + Send + Sync,
>;

/// Type alias for bidirectional handler.
pub type BidirectionalHandler = Arc<
    dyn Fn(mpsc::Receiver<Request>, StreamingHandlerContext) -> Pin<Box<dyn Future<Output = Result<(), SdkError>> + Send>> + Send + Sync,
>;

/// Register a server-streaming handler.
pub fn on_streaming<F, Fut>(mut self, cap: impl Into<String>, f: F) -> Self
where
    F: Fn(Request, StreamingHandlerContext) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<(), SdkError>> + Send + 'static,
{
    let cap = cap.into();
    let handler = Arc::new(move |req: Request, ctx: StreamingHandlerContext| {
        Box::pin(f(req, ctx))
    });
    self.streaming_handlers.insert(cap, (HandlerMode::ServerStreaming, handler));
    self
}

/// Register a bidirectional handler.
pub fn on_bidirectional<F, Fut>(mut self, cap: impl Into<String>, f: F) -> Self
where
    F: Fn(mpsc::Receiver<Request>, StreamingHandlerContext) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<(), SdkError>> + Send + 'static,
{
    let cap = cap.into();
    let handler = Arc::new(move |rx: mpsc::Receiver<Request>, ctx: StreamingHandlerContext| {
        Box::pin(f(rx, ctx))
    });
    self.streaming_handlers.insert(cap, (HandlerMode::Bidirectional, handler));
    self
}
```

### Server-Side Streaming Implementation
```rust
// For server-streaming handlers:
let (tx, mut rx) = mpsc::channel::<Result<Response, SdkError>>(32);
let ctx = StreamingHandlerContext {
    cancel: cancel_token.clone(),
    capability: capability.clone(),
    sender: ResponseSender { inner: tx },
};

// Spawn handler
tokio::spawn(async move {
    if let Err(e) = handler(request, ctx).await {
        tracing::error!("Streaming handler error: {:?}", e);
    }
});

// Forward responses to QUIC stream
while let Some(result) = rx.recv().await {
    match result {
        Ok(resp) => {
            let rpc_resp = RpcResponse::success(rpc_req.id, resp.result.to_value());
            let frame = Frame::data(0, rpc_resp.encode()?);
            send.write_all(&encode_frame(&frame)?).await?;
            // Don't call finish() - keep stream open for more frames
        }
        Err(e) => {
            let rpc_err = RpcResponse::error(rpc_req.id, RpcErrorObject::new(5000, e.to_string()));
            let frame = Frame::data(0, rpc_err.encode()?);
            send.write_all(&encode_frame(&frame)?).await?;
            send.finish();
            break;
        }
    }
}
```

### Client-Side Streaming API
```rust
/// Streaming call builder.
pub struct StreamingCallBuilder<'a> {
    agent: &'a SdkAgent,
    capability: String,
    request: Request,
}

impl<'a> StreamingCallBuilder<'a> {
    /// Execute a streaming call, returns a stream of responses.
    pub async fn stream(self) -> Result<ResponseStream, SdkError> {
        // Open bi-stream without calling finish()
        let (mut send, mut recv) = conn.open_bi().await?;

        // Send request
        let frame = Frame::data(0, rpc_bytes);
        send.write_all(&encode_frame(&frame)?).await?;
        // Don't finish - keep send side open for bidirectional

        // Spawn reader task
        let (tx, rx) = mpsc::channel(32);
        tokio::spawn(async move {
            loop {
                // Read response frames
                let header = read_header(&mut recv).await?;
                let body = read_body(&mut recv, header).await?;
                let (frame, _) = decode_frame(&body)?;

                // Decode RPC response
                let rpc_resp = RpcResponse::decode(&frame.payload)?;

                if !rpc_resp.is_success() {
                    let _ = tx.send(Err(SdkError::Messaging(rpc_resp.error.unwrap().message))).await;
                    break;
                }

                let response = Response::from_rpc_result(rpc_resp.result.unwrap());
                if tx.send(Ok(response)).await.is_err() {
                    break; // Receiver dropped
                }
            }
        });

        Ok(ResponseStream { inner: rx })
    }
}

// Usage:
let mut stream = agent.discover("token_stream")
    .call_streaming(Request::text("start"))
    .await?;

while let Some(result) = stream.next().await {
    match result {
        Ok(resp) => println!("Token: {}", resp.body()),
        Err(e) => break,
    }
}
```

### Ergonomics
```rust
// Server: Token streaming
Agent::serve()
    .capability("token_stream")
    .on_streaming("token_stream", |req, ctx| async move {
        for i in 0..10 {
            if ctx.cancel.is_cancelled() {
                break;
            }
            ctx.sender.send(Response::text(format!("token_{}", i))).await?;
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        Ok(())
    })
    .start()
    .await?;

// Client: Consume stream
let mut stream = agent.discover("token_stream")
    .call_streaming(Request::text("start"))
    .await?;

while let Some(result) = stream.next().await {
    match result {
        Ok(resp) => println!("Token: {}", resp.body()),
        Err(e) => eprintln!("Error: {:?}", e),
    }
}
```

---

## 4. Session Affinity + Connection Reuse

### Problem
Every discover().call() does a fresh dial + ML-DSA-65 handshake. ConnectionPool exists in the codebase but is unused by the simple API. A 5-step chain pays 5 handshakes.

### Solution
Integrate ConnectionPool into ConnectedAgent. Use session-based routing (same session -> same connection). Expose pool configuration.

### Design

```rust
/// Connected agent with connection pooling (v2).
pub struct ConnectedAgent {
    agent: Arc<SdkAgent>,
    /// Connection pool for reusing connections (v2).
    pool: Arc<ConnectionPool>,
}

impl ConnectBuilder {
    /// Build the agent with connection pooling enabled (v2).
    pub async fn connect(self) -> Result<ConnectedAgent, SdkError> {
        let agent = AgentBuilder::new()
            .with_seeds(self.seeds)
            .with_keypair_option(self.keypair)
            .build()
            .await?;

        let pool = Arc::new(ConnectionPool::new(PoolConfig::default()));

        Ok(ConnectedAgent { agent, pool })
    }

    /// Build with custom pool config (v2).
    pub async fn connect_with_pool(self, config: PoolConfig) -> Result<ConnectedAgent, SdkError> {
        let agent = AgentBuilder::new()
            .with_seeds(self.seeds)
            .with_keypair_option(self.keypair)
            .build()
            .await?;

        let pool = Arc::new(ConnectionPool::new(config));

        Ok(ConnectedAgent { agent, pool })
    }
}

impl ConnectedAgent {
    /// Discovery with connection pooling (v2).
    pub fn discover(&self, capability: &str) -> DiscoveryBuilderV2 {
        DiscoveryBuilderV2 {
            agent: self.agent.clone(),
            pool: self.pool.clone(),
            capability: capability.to_string(),
        }
    }
}

/// Discovery builder with connection pooling (v2).
pub struct DiscoveryBuilderV2 {
    agent: Arc<SdkAgent>,
    pool: Arc<ConnectionPool>,
    capability: String,
}

impl DiscoveryBuilderV2 {
    /// Call with connection pooling (v2).
    pub async fn call(&self, request: Request) -> Result<Response, SdkError> {
        let candidates = self.agent.find_by_capability(&self.capability);
        if candidates.is_empty() {
            return Err(SdkError::Discovery(format!(
                "no agents found for capability '{}'",
                self.capability
            )));
        }

        // Try all candidates with failover (v2)
        for peer in candidates {
            if let Some(addr) = peer.endpoints.first() {
                // Use connection pool
                let (peer_id, conn) = self.pool.get_or_connect(&self.agent, addr).await?;

                // Make the call on the pooled connection
                match call_agent_on_connection(&self.agent, &conn, peer_id, request.clone()).await {
                    Ok(resp) => return Ok(resp),
                    Err(e) => {
                        tracing::warn!("Call to {} failed: {:?}", addr, e);
                        // Try next candidate
                        continue;
                    }
                }
            }
        }

        Err(SdkError::Discovery("all candidates failed".to_string()))
    }
}

/// Internal helper: call on an existing connection.
async fn call_agent_on_connection(
    agent: &SdkAgent,
    conn: &QuicConnection,
    peer_id: AgentId,
    request: Request,
) -> Result<Response, SdkError> {
    // Use existing connection, skip handshake
    let (mut send, mut recv) = conn.open_bi().await?;

    // Encode and send request
    let rpc_req = RpcRequest::new(1, request.metadata.capability)
        .with_params(request.params.to_value());
    let frame = Frame::data(0, rpc_req.encode()?);
    send.write_all(&encode_frame(&frame)?).await?;
    send.finish();

    // Read response
    // ... (same as before)

    // Release connection back to pool
    // Note: pool.release() is called by the caller

    Ok(response)
}
```

### Ergonomics
```rust
// v2: Connection pooling enabled by default
let agent = Agent::connect()
    .connect()
    .await?;

// First call: establishes connection (240us)
let resp1 = agent.discover("echo").call(Request::text("hello")).await?;

// Second call: reuses connection (14us)
let resp2 = agent.discover("echo").call(Request::text("world")).await?;

// Custom pool config
let agent = Agent::connect()
    .connect_with_pool(PoolConfig {
        max_size: 50,
        idle_timeout: Duration::from_secs(120),
    })
    .await?;
```

---

## 5. Request/Response Metadata

### Problem
Request has only text/data. Session IDs, deadlines, trace IDs, content-types all must be encoded into the body string.

### Solution
Add RequestMetadata and ResponseMetadata structs. Populate from RPC extensions or custom headers.

### Design

```rust
/// Request metadata.
#[derive(Debug, Clone)]
pub struct RequestMetadata {
    /// The capability name being invoked.
    pub capability: String,
    /// Session ID (from handshake transcript).
    pub session_id: Option<[u8; 32]>,
    /// Trace ID for distributed tracing.
    pub trace_id: Option<String>,
    /// Request deadline (ISO 8601).
    pub deadline: Option<String>,
    /// Content type (for binary payloads).
    pub content_type: Option<String>,
}

impl Default for RequestMetadata {
    fn default() -> Self {
        Self {
            capability: String::new(),
            session_id: None,
            trace_id: None,
            deadline: None,
            content_type: None,
        }
    }
}

/// Response metadata.
#[derive(Debug, Clone)]
pub struct ResponseMetadata {
    /// Content type (for binary payloads).
    pub content_type: Option<String>,
    /// Additional metadata fields.
    pub extra: HashMap<String, String>,
}

impl Default for ResponseMetadata {
    fn default() -> Self {
        Self {
            content_type: None,
            extra: HashMap::new(),
        }
    }
}

impl ResponseMetadata {
    /// Set content type.
    pub fn with_content_type(mut self, ct: impl Into<String>) -> Self {
        self.content_type = Some(ct.into());
        self
    }

    /// Add extra metadata.
    pub fn put(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.extra.insert(key.into(), value.into());
        self
    }
}

// Wire encoding: Use frame extensions for metadata
pub fn encode_metadata(metadata: &RequestMetadata) -> Vec<u8> {
    // Encode as CBOR in the extension section
    let mut map = vec![];
    if !metadata.capability.is_empty() {
        map.push((1, Value::TextString(metadata.capability.clone())));
    }
    if let Some(sid) = metadata.session_id {
        map.push((2, Value::ByteString(sid.to_vec())));
    }
    if let Some(trace_id) = &metadata.trace_id {
        map.push((3, Value::TextString(trace_id.clone())));
    }
    if let Some(deadline) = &metadata.deadline {
        map.push((4, Value::TextString(deadline.clone())));
    }
    if let Some(ct) = &metadata.content_type {
        map.push((5, Value::TextString(ct.clone())));
    }
    aafp_cbor::encode(&Value::IntMap(map)).unwrap_or_default()
}

pub fn decode_request_metadata(data: &[u8]) -> RequestMetadata {
    let mut metadata = RequestMetadata::default();
    if let Ok((val, _)) = aafp_cbor::decode(data) {
        if let Value::IntMap(entries) = val {
            for (key, value) in entries {
                match key {
                    1 => {
                        if let Value::TextString(s) = value {
                            metadata.capability = s;
                        }
                    }
                    2 => {
                        if let Value::ByteString(b) = value {
                            if b.len() == 32 {
                                let mut sid = [0u8; 32];
                                sid.copy_from_slice(&b);
                                metadata.session_id = Some(sid);
                            }
                        }
                    }
                    3 => {
                        if let Value::TextString(s) = value {
                            metadata.trace_id = Some(s);
                        }
                    }
                    4 => {
                        if let Value::TextString(s) = value {
                            metadata.deadline = Some(s);
                        }
                    }
                    5 => {
                        if let Value::TextString(s) = value {
                            metadata.content_type = Some(s);
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    metadata
}
```

### Ergonomics
```rust
// Client: Set metadata
let req = Request::with_params(Params::new().put_str(1, "hello"))
    .with_metadata(|m| {
        m.trace_id = Some("trace-123".to_string());
        m.deadline = Some("2025-01-15T12:00:00Z".to_string());
    });

// Server: Access metadata
Agent::serve()
    .on_capability("echo", |req, ctx| async move {
        println!("Trace ID: {:?}", req.metadata.trace_id);
        println!("Session ID: {:?}", req.metadata.session_id);
        Ok(Response::text(req.body()))
    })
    .start()
    .await?;
```

---

## 6. Multi-Handler Routing

### Problem
One handler per ServeBuilder (no per-capability routing). Forces body-prefix dispatch hacks.

### Solution
Already addressed in Section 2 (Capability Forwarding). Use HashMap<String, CapabilityHandler> for per-capability routing.

### Design (Recap)
```rust
pub struct ServeBuilder {
    capabilities: Vec<String>,
    /// Per-capability handlers.
    capability_handlers: HashMap<String, CapabilityHandler>,
    /// Fallback handler (v1 compat).
    fallback_handler: Option<HandlerFnV2>,
    // ...
}

impl ServeBuilder {
    /// Register a handler for a specific capability.
    pub fn on_capability<F, Fut>(mut self, cap: impl Into<String>, f: F) -> Self
    where
        F: Fn(Request, HandlerContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Response, SdkError>> + Send + 'static,
    {
        let cap = cap.into();
        let handler = Arc::new(move |req: Request, ctx: HandlerContext| {
            Box::pin(f(req, ctx))
        });
        self.capability_handlers.insert(cap, handler);
        self
    }
}
```

### Ergonomics
```rust
Agent::serve()
    .capability("echo")
    .on_capability("echo", |req, ctx| async move {
        Ok(Response::text(req.body()))
    })
    .capability("sum")
    .on_capability("sum", |req, ctx| async move {
        let a = req.params.get_u64(1).unwrap_or(0);
        let b = req.params.get_u64(2).unwrap_or(0);
        Ok(Response::with_result(Params::new().put_u64(1, a + b)))
    })
    .capability("uppercase")
    .on_capability("uppercase", |req, ctx| async move {
        Ok(Response::text(req.body().to_uppercase()))
    })
    .start()
    .await?;
```

---

## 7. Handler Cancellation

### Problem
No handler cancellation (orphaned handlers run to completion on client disconnect).

### Solution
Pass tokio_util::sync::CancellationToken to handlers via HandlerContext. Cancel on client disconnect.

### Design (Recap from Section 2)
```rust
use tokio_util::sync::CancellationToken;

/// Handler context with cancellation token.
pub struct HandlerContext {
    /// Cancellation token (fires when client disconnects).
    pub cancel: CancellationToken,
    /// The capability being invoked.
    pub capability: String,
}

// In the request handling loop:
let cancel_token = CancellationToken::new();
let ctx = HandlerContext {
    cancel: cancel_token.clone(),
    capability: capability.clone(),
};

tokio::select! {
    result = handler(request, ctx) => {
        // Handle result
    }
    _ = cancel_token.cancelled() => {
        // Client disconnected, abort handler
    }
}

// Detect client disconnect:
tokio::spawn(async move {
    // Wait for recv stream to close
    let mut buf = [0u8; 1];
    if recv.read(&mut buf).await.is_err() {
        // Client disconnected
        cancel_token.cancel();
    }
});
```

### Ergonomics
```rust
Agent::serve()
    .on_capability("long_task", |req, ctx| async move {
        for i in 0..100 {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(100)) => {
                    // Do work
                }
                _ = ctx.cancel.cancelled() => {
                    println!("Handler cancelled by client disconnect");
                    return Err(SdkError::Messaging("cancelled".to_string()));
                }
            }
        }
        Ok(Response::text("done"))
    })
    .start()
    .await?;
```

---

## 8. Typed Errors

### Problem
No typed error codes (single 5000+string). RFC-0005 defines rich error categories but simple API doesn't expose them.

### Solution
Use aafp_core::ProtocolError and error codes. Expose typed error enum for handlers.

### Design

```rust
use aafp_core::{ProtocolError, codes as error_codes};

/// Typed error for handler responses.
#[derive(Debug, thiserror::Error)]
pub enum HandlerError {
    /// Transport error (1xxx).
    #[error("transport error: {0}")]
    Transport(String),
    /// Authentication error (2xxx).
    #[error("authentication error: {0}")]
    Authentication(String),
    /// Authorization error (3xxx).
    #[error("authorization error: {0}")]
    Authorization(String),
    /// Discovery error (4xxx).
    #[error("discovery error: {0}")]
    Discovery(String),
    /// Messaging error (5xxx).
    #[error("messaging error: {0}")]
    Messaging(String),
    /// Capability error (6xxx).
    #[error("capability error: {0}")]
    Capability(String),
    /// Protocol error (8xxx).
    #[error("protocol error: {0}")]
    Protocol(String),
    /// Application error (9xxx).
    #[error("application error: {0}")]
    Application(String),
}

impl HandlerError {
    /// Convert to wire error code.
    pub fn to_code(&self) -> u32 {
        match self {
            Self::Transport(_) => error_codes::CONNECTION_RESET,
            Self::Authentication(_) => error_codes::INVALID_SIGNATURE,
            Self::Authorization(_) => error_codes::UNAUTHORIZED,
            Self::Discovery(_) => error_codes::CAPABILITY_NOT_FOUND,
            Self::Messaging(_) => error_codes::METHOD_PARAMS_INVALID,
            Self::Capability(_) => error_codes::UNSUPPORTED_CAPABILITY,
            Self::Protocol(_) => error_codes::PROTOCOL_VIOLATION,
            Self::Application(_) => 9000, // Application error range
        }
    }

    /// Create from wire error code.
    pub fn from_code(code: u32, message: String) -> Self {
        match error_codes::ErrorCategory::from_code(code) {
            error_codes::ErrorCategory::Transport => Self::Transport(message),
            error_codes::ErrorCategory::Authentication => Self::Authentication(message),
            error_codes::ErrorCategory::Authorization => Self::Authorization(message),
            error_codes::ErrorCategory::Discovery => Self::Discovery(message),
            error_codes::ErrorCategory::Messaging => Self::Messaging(message),
            error_codes::ErrorCategory::Capability => Self::Capability(message),
            error_codes::ErrorCategory::Protocol => Self::Protocol(message),
            error_codes::ErrorCategory::Application => Self::Application(message),
            _ => Self::Protocol(message),
        }
    }
}

impl From<HandlerError> for SdkError {
    fn from(err: HandlerError) -> Self {
        SdkError::Messaging(err.to_string())
    }
}

// Update handler signature to return HandlerError
pub type HandlerFnV2 = Arc<
    dyn Fn(Request, HandlerContext) -> Pin<Box<dyn Future<Output = Result<Response, HandlerError>> + Send>> + Send + Sync,
>;

// In response encoding:
let rpc_resp = match handler(request).await {
    Ok(response) => {
        RpcResponse::success(rpc_req.id, response.result.to_value())
    }
    Err(err) => {
        RpcResponse::error(rpc_req.id, RpcErrorObject::new(err.to_code(), err.to_string()))
    }
};
```

### Ergonomics
```rust
Agent::serve()
    .on_capability("sum", |req, ctx| async move {
        let a = req.params.get_u64(1).ok_or_else(|| {
            HandlerError::Messaging("missing param 'a'".to_string())
        })?;
        let b = req.params.get_u64(2).ok_or_else(|| {
            HandlerError::Messaging("missing param 'b'".to_string())
        })?;

        if a.checked_add(b).is_none() {
            return Err(HandlerError::Messaging("overflow".to_string()));
        }

        Ok(Response::with_result(Params::new().put_u64(1, a + b)))
    })
    .start()
    .await?;
```

---

## 9. Discovery Improvements

### Problem
- DiscoveryBuilder borrows &SdkAgent so calls aren't 'static (can't tokio::spawn)
- discover() only tries [0], no failover to other candidates

### Solution
- Use Arc<SdkAgent> instead of &SdkAgent
- Loop through all candidates with failover
- Add discover_by_agent_id()

### Design

```rust
/// Connected agent with Arc for 'static discovery (v2).
pub struct ConnectedAgent {
    agent: Arc<SdkAgent>,
    pool: Arc<ConnectionPool>,
}

impl ConnectedAgent {
    /// Discovery returns 'static builder (v2).
    pub fn discover(&self, capability: &str) -> DiscoveryBuilderV2 {
        DiscoveryBuilderV2 {
            agent: self.agent.clone(),
            pool: self.pool.clone(),
            capability: capability.to_string(),
        }
    }

    /// Discover by specific agent ID (v2).
    pub fn discover_by_id(&self, agent_id: AgentId) -> DirectCallBuilder {
        DirectCallBuilder {
            agent: self.agent.clone(),
            pool: self.pool.clone(),
            agent_id,
        }
    }
}

/// Discovery builder with failover (v2).
pub struct DiscoveryBuilderV2 {
    agent: Arc<SdkAgent>,
    pool: Arc<ConnectionPool>,
    capability: String,
}

impl DiscoveryBuilderV2 {
    /// Call with failover across all candidates (v2).
    pub async fn call(&self, request: Request) -> Result<Response, SdkError> {
        let candidates = self.agent.find_by_capability(&self.capability);
        if candidates.is_empty() {
            return Err(SdkError::Discovery(format!(
                "no agents found for capability '{}'",
                self.capability
            )));
        }

        // Try all candidates with failover
        let mut last_error = None;
        for peer in candidates {
            if let Some(addr) = peer.endpoints.first() {
                match self.pool.get_or_connect(&self.agent, addr).await {
                    Ok((peer_id, conn)) => {
                        match call_agent_on_connection(&self.agent, &conn, peer_id, request.clone()).await {
                            Ok(resp) => return Ok(resp),
                            Err(e) => {
                                last_error = Some(e);
                                continue;
                            }
                        }
                    }
                    Err(e) => {
                        last_error = Some(e);
                        continue;
                    }
                }
            }
        }

        Err(last_error.unwrap_or_else(|| {
            SdkError::Discovery("all candidates failed".to_string())
        }))
    }
}

/// Direct call builder (by agent ID).
pub struct DirectCallBuilder {
    agent: Arc<SdkAgent>,
    pool: Arc<ConnectionPool>,
    agent_id: AgentId,
}

impl DirectCallBuilder {
    /// Call the specific agent.
    pub async fn call(&self, request: Request) -> Result<Response, SdkError> {
        // Find agent record by ID
        let record = self.agent.dht.get_by_id(&self.agent_id)
            .ok_or_else(|| SdkError::Discovery("agent not found".to_string()))?;

        let addr = record.endpoints.first()
            .ok_or_else(|| SdkError::Discovery("agent has no endpoints".to_string()))?;

        let (peer_id, conn) = self.pool.get_or_connect(&self.agent, addr).await?;
        call_agent_on_connection(&self.agent, &conn, peer_id, request).await
    }
}
```

### Ergonomics
```rust
// v2: 'static discovery, can tokio::spawn
let agent = Agent::connect().connect().await?;

let discover = agent.discover("echo");
tokio::spawn(async move {
    let resp = discover.call(Request::text("hello")).await?;
    println!("{}", resp.body());
    Ok::<_, SdkError>(())
});

// v2: Failover across candidates
let resp = agent.discover("echo")
    .call(Request::text("hello"))
    .await?; // Tries all candidates automatically

// v2: Direct call by agent ID
let agent_id = AgentId::from_bytes(&[...]);
let resp = agent.discover_by_id(agent_id)
    .call(Request::text("hello"))
    .await?;
```

---

## 10. Backwards Compatibility

### Problem
How to evolve without breaking existing P2.1-P2.5 code.

### Solution
- Keep v1 API as deprecated but functional
- Add v2 API alongside v1
- Use feature flags or versioned modules
- Provide migration guide

### Design

```rust
// simple.rs structure:

//! # Simple API v2
//!
//! ## v2 API (recommended)
//!
//! ```no_run
//! use aafp_sdk::simple::{Agent, Request, Response, Params};
//!
//! # async fn run() -> Result<(), Box<dyn std::error::Error>> {
//! // Serve with structured params
//! Agent::serve()
//!     .capability("sum")
//!     .on_capability("sum", |req, ctx| async move {
//!         let a = req.params.get_u64(1).unwrap_or(0);
//!         let b = req.params.get_u64(2).unwrap_or(0);
//!         Ok(Response::with_result(Params::new().put_u64(1, a + b)))
//!     })
//!     .start()
//!     .await?;
//!
//! // Call with connection pooling
//! let agent = Agent::connect().connect().await?;
//! let resp = agent.discover("sum")
//!     .call(Request::with_params(Params::new().put_u64(1, 5).put_u64(2, 7)))
//!     .await?;
//! # Ok(())
//! # }
//! ```
//!
//! ## v1 API (deprecated, backward compat)
//!
//! ```no_run
//! use aafp_sdk::simple::{Agent, Request, Response};
//!
//! # async fn run() -> Result<(), Box<dyn std::error::Error>> {
//! Agent::serve()
//!     .capability("echo")
//!     .handler(|req: Request| async move { Ok(Response::text(req.body())) })
//!     .start()
//!     .await?;
//! # Ok(())
//! # }
//! ```
//!
//! ## Migration Guide
//!
//! 1. Replace `handler()` with `on_capability()` for per-capability routing
//! 2. Use `Params` for structured request/response data
//! 3. Connection pooling is enabled by default in v2
//! 4. Add `HandlerContext` to handlers for cancellation support
//! 5. Use `HandlerError` for typed error codes

// v2 types (new)
pub use v2::{Params, RequestMetadata, ResponseMetadata, HandlerContext, HandlerError};

// v1 types (deprecated but kept)
#[deprecated(since = "2.0.0", note = "Use v2 API instead")]
pub type HandlerFn = /* v1 definition */;

// v2 ServeBuilder
pub struct ServeBuilder {
    // v2 fields
}

// v1 compatibility wrapper
#[deprecated(since = "2.0.0", note = "Use ServeBuilder::on_capability instead")]
impl ServeBuilder {
    pub fn handler<F, Fut>(self, f: F) -> Self
    where
        F: Fn(Request) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Response, String>> + Send + 'static,
    {
        // Convert v1 handler to v2 fallback handler
        let handler = Arc::new(move |req: Request, _ctx: HandlerContext| {
            Box::pin(async move {
                f(req).await.map_err(|e| SdkError::Messaging(e))
            })
        });
        self.fallback_handler = Some(handler);
        self
    }
}
```

### Migration Path
1. **Phase 1**: Add v2 types alongside v1 (no breaking changes)
2. **Phase 2**: Deprecate v1 APIs with compiler warnings
3. **Phase 3**: Update all internal code to use v2
4. **Phase 4**: Remove v1 APIs in next major version

### Compatibility Matrix

| Feature | v1 | v2 | Notes |
|---------|----|----|-------|
| Request/Response | text XOR binary | params + text + binary | v1 still works |
| Handler routing | single handler | per-capability handlers | v1 uses fallback |
| Capability forwarding | No | Yes via metadata | v1 can't access |
| Streaming | No | Yes | v1 only unary |
| Connection pooling | No | Yes | v1 always dials |
| Metadata | No | Yes | v1 encodes in body |
| Cancellation | No | Yes | v1 runs to completion |
| Typed errors | No | Yes | v1 uses 5000+string |
| Discovery borrow | &SdkAgent | Arc<SdkAgent> | v1 can't spawn |
| Failover | No (tries [0] only) | Yes (loops all) | v1 single attempt |

---

## Implementation Phases

### Phase 1: Foundation (Week 1-2)
- [ ] Add Params, RequestMetadata, ResponseMetadata types
- [ ] Update Request/Response to carry params and metadata
- [ ] Add HandlerContext with CancellationToken
- [ ] Add HandlerError enum
- [ ] Update wire encoding/decoding for metadata

### Phase 2: Server-Side (Week 3-4)
- [ ] Implement per-capability handler routing
- [ ] Add on_capability() to ServeBuilder
- [ ] Implement handler cancellation
- [ ] Add streaming handler support
- [ ] Update request handling loop

### Phase 3: Client-Side (Week 5-6)
- [ ] Integrate ConnectionPool into ConnectedAgent
- [ ] Update DiscoveryBuilder to use pool
- [ ] Implement failover across candidates
- [ ] Add discover_by_id()
- [ ] Change to Arc<SdkAgent> for 'static discovery

### Phase 4: Streaming (Week 7-8)
- [ ] Implement server-streaming handlers
- [ ] Implement bidirectional handlers
- [ ] Add ResponseStream / ResponseSender
- [ ] Implement client-side streaming API
- [ ] Add streaming call builder

### Phase 5: Migration & Testing (Week 9-10)
- [ ] Add v1 compatibility wrappers
- [ ] Deprecate v1 APIs
- [ ] Write migration guide
- [ ] Update all sandbox tests to v2
- [ ] Add integration tests for new features

---

## Summary

This design addresses all 10 gaps:

1. **Structured Request/Response** -- Params type exposes CBOR IntMap
2. **Capability forwarding** -- RequestMetadata.capability + per-capability handlers
3. **Streaming API** -- Server-streaming, bidirectional, ResponseStream
4. **Session affinity** -- ConnectionPool integration, session-based routing
5. **Request metadata** -- RequestMetadata, ResponseMetadata structs
6. **Multi-handler routing** -- HashMap<String, CapabilityHandler>
7. **Handler cancellation** -- CancellationToken in HandlerContext
8. **Typed errors** -- HandlerError enum with RFC-0005 codes
9. **Discovery improvements** -- Arc<SdkAgent>, failover, discover_by_id
10. **Backwards compatibility** -- v1 APIs deprecated but functional

The design maintains the "no protocol knowledge required" philosophy while exposing the full power of the underlying AAFP protocol.
