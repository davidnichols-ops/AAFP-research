# Streaming RPC Design Document

## Executive Summary

AAFP's current simple API is strictly request-response (one request -> one response), which is insufficient for modern agent workflows requiring streaming, progress updates, cancellation, and interactive sessions. The underlying QUIC transport already supports bidirectional streams, flow control, and stream reset—these features are simply not exposed through the SDK. This design proposes adding streaming RPC patterns (server-streaming, client-streaming, bidirectional) using existing AAFP frame types with no wire protocol changes required.

---

## 1. Available QUIC Features Analysis

### 1.1 Bidirectional Streams (Currently Underutilized)

**Location**: `aafp-transport-quic/src/transport.rs:272-309`

**Available APIs**:
```rust
// Client-side
pub async fn open_bi(&self) -> Result<(QuicSendStream, QuicRecvStream), Error>

// Server-side
pub async fn accept_bi(&self) -> Result<(QuicSendStream, QuicRecvStream), Error>
```

**Current Usage in Simple API** (`aafp-sdk/src/simple.rs:460-521`):
- Opens bi-stream for each RPC call
- **Immediately calls `send.finish()` after writing request** (line 485)
- Reads exactly one response frame
- Stream is half-closed and discarded after single exchange

**Streaming Opportunity**: Keep the bi-stream open after the initial request, allowing multiple response frames to be sent before calling `send.finish()`.

### 1.2 Flow Control (QUIC Transport Level)

**Location**: `aafp-transport-quic/src/config.rs:79-97`

**Configurable Parameters**:
```rust
pub struct QuicConfig {
    pub max_concurrent_streams: u64,           // Max concurrent streams per connection
    pub stream_initial_max_data: u64,          // Initial stream flow control window
    pub max_idle_timeout: Duration,            // Connection idle timeout
    pub max_ack_delay: Duration,              // ACK delay for congestion control
    // ...
}
```

**Current State**: Flow control is active at the transport layer but not exposed to the application. Applications cannot signal backpressure or observe flow control state.

**Streaming Opportunity**: Expose flow control state to handlers via a `StreamContext` object, allowing handlers to backpressure when the client is slow to consume.

### 1.3 Stream Reset (Cancellation Primitive)

**Location**: `aafp-transport-quic/src/transport.rs:393-395, 430-432`

**Available APIs**:
```rust
// Send-side reset (aborts sending)
pub fn reset(&mut self, code: u32)

// Receive-side stop (signals sender to stop)
pub fn stop(&mut self, code: u32)
```

**Current State**: Not exposed through the simple API. No cancellation mechanism exists for in-flight RPCs.

**Streaming Opportunity**: Map QUIC stream reset to application-level cancellation. When a client drops a streaming response future, reset the stream to notify the server to stop work.

### 1.4 Unidirectional Streams (Not Currently Used)

**Available APIs**:
```rust
pub async fn open_uni(&self) -> Result<QuicSendStream, Error>
pub async fn accept_uni(&self) -> Result<QuicRecvStream, Error>
```

**Current State**: Not used in AAFP. All streams are bidirectional.

**Streaming Opportunity**: Use unidirectional streams for server-sent events (SSE) pattern where server pushes updates without client requests.

---

## 2. MORE Flag Semantics and Streaming

### 2.1 Current MORE Flag Semantics

**Location**: RFC-0002 §4.1 (lines 218-220)

**Current Specification**:
```
Flags:
- 0x01 (MORE): More fragments follow on this stream. The receiver
  MUST buffer fragments until a DATA frame without the MORE flag is
  received, then deliver the assembled message.
```

**Current Implementation** (`aafp-messaging/src/framing.rs:124-131, 193-202`):
```rust
pub mod flags {
    pub const MORE: u8 = 0x01;
    pub const COMPRESSED: u8 = 0x02;
    pub const CRITICAL: u8 = 0x80;
}

impl Frame {
    pub fn with_more(mut self) -> Self {
        self.flags |= flags::MORE;
        self
    }

    pub fn has_more(&self) -> bool {
        self.flags & flags::MORE != 0
    }
}
```

**Current Usage**: Only for fragmentation of large messages (>1 MiB). Frames with MORE set are buffered and reassembled before delivery to the application.

### 2.2 Streaming Semantics Proposal

**Proposal**: Repurpose the MORE flag for application-level streaming while maintaining backward compatibility for fragmentation.

**Two-Level Interpretation**:
1. **Fragmentation Mode (existing)**: When a single RPC payload exceeds 1 MiB, fragment across multiple DATA frames with MORE flag. Receiver reassembles before delivering to application.
2. **Streaming Mode (new)**: When the RPC method is registered as "streaming", each DATA frame with MORE flag represents a complete application message (not a fragment). Receiver delivers each frame as it arrives.

**Distinguishing the Modes**:
- Method registration in `RpcServer` includes a `StreamingMode` enum
- Per-method metadata in the handshake capabilities (RFC-0006 extension)
- Client and server agree on streaming mode per method during capability negotiation

**Wire Compatibility**: No changes required. The interpretation of MORE is a local decision based on method metadata.

---

## 3. Server-Streaming RPC Design

### 3.1 Pattern Definition

**Semantics**: Client sends one request, server sends multiple response frames on the same bi-stream.

**Use Cases**:
- LLM token streaming (generate tokens one at a time)
- Progress updates on long tasks
- Partial results before final result
- Server-sent events (push updates)

### 3.2 Handler Signature

```rust
use futures::stream::Stream;
use tokio_stream::wrappers::ReceiverStream;

/// Streaming response handler
pub type StreamingHandlerFn = Arc<
    dyn Fn(Request, CancellationToken) -> Pin<Box<dyn Stream<Item = Result<Response, String>> + Send>>
    + Send + Sync
>;

/// Register a streaming handler
impl ServeBuilder {
    pub fn streaming_handler<F, S>(mut self, f: F) -> Self
    where
        F: Fn(Request, CancellationToken) -> S + Send + Sync + 'static,
        S: Stream<Item = Result<Response, String>> + Send + 'static,
    {
        self.streaming_handler = Some(Arc::new(move |req, cancel| {
            Box::pin(f(req, cancel))
        }));
        self
    }
}
```

### 3.3 Client API

```rust
impl ConnectedAgent {
    /// Call an agent with streaming response
    pub async fn call_stream(
        &self,
        capability: &str,
        request: Request
    ) -> Result<impl Stream<Item = Result<Response, SdkError>>, SdkError> {
        // 1. Dial and handshake (reuse connection pool)
        let conn = self.transport.dial(addr).await?;
        let (_session, conn, _peer_info) = establish_session(...).await?;

        // 2. Open bi-stream but DO NOT call send.finish()
        let (mut send, mut recv) = conn.open_bi().await?;

        // 3. Send request frame
        let frame = Frame::data(0, rpc_bytes);
        let frame_bytes = encode_frame(&frame)?;
        send.write_all(&frame_bytes).await?;
        // NOTE: do NOT call send.finish() - keep stream open

        // 4. Return a stream that reads response frames
        let response_stream = async_stream::try_stream! {
            loop {
                let mut header = [0u8; FRAME_HEADER_SIZE];
                recv.read_exact(&mut header).await?;

                let frame = decode_frame(&full_frame)?;

                // Check MORE flag
                if !frame.has_more() {
                    // Final frame - deliver and break
                    let response = decode_response(&frame.payload)?;
                    yield response;
                    break;
                }

                // Intermediate frame - deliver and continue
                let response = decode_response(&frame.payload)?;
                yield response;
            }
        };

        Ok(response_stream)
    }
}
```

### 3.4 Server-Side Implementation

```rust
// In ServeBuilder::start() handler loop
tokio::spawn(async move {
    let (mut send, mut recv) = conn.accept_bi().await?;

    // Read request frame
    let (frame, _) = decode_frame(&full_frame)?;
    let rpc_req = RpcRequest::decode(&frame.payload)?;

    // Call streaming handler with cancellation token
    let cancel_token = CancellationToken::new();
    let response_stream = (streaming_handler)(request, cancel_token.clone());

    // Stream responses
    tokio::pin!(response_stream);

    while let Some(result) = response_stream.next().await {
        match result {
            Ok(response) => {
                // Encode response as RPC_RESPONSE frame
                let rpc_resp = RpcResponse::success(rpc_req.id, result_value);
                let resp_bytes = rpc_resp.encode()?;

                // Send with MORE flag (unless this is the last frame)
                let more_flag = if response_stream.is_terminated() { 0 } else { flags::MORE };
                let resp_frame = Frame {
                    frame_type: FrameType::RpcResponse,
                    flags: more_flag,
                    stream_id: 0,
                    extensions: vec![],
                    payload: resp_bytes,
                };

                let frame_bytes = encode_frame(&resp_frame)?;
                send.write_all(&frame_bytes).await?;
            }
            Err(e) => {
                // Send error response
                let rpc_resp = RpcResponse::error(rpc_req.id, RpcErrorObject::new(5000, e));
                let resp_bytes = rpc_resp.encode()?;
                let resp_frame = Frame::data(0, resp_bytes);
                let frame_bytes = encode_frame(&resp_frame)?;
                send.write_all(&frame_bytes).await?;
                break;
            }
        }
    }

    // Send final frame without MORE flag
    send.finish();
});
```

### 3.5 Cancellation Integration

```rust
// Client-side cancellation
impl ConnectedAgent {
    pub async fn call_stream_with_cancel(
        &self,
        capability: &str,
        request: Request,
    ) -> Result<(impl Stream<Item = Result<Response, SdkError>>, CancellationToken), SdkError> {
        let cancel_token = CancellationToken::new();
        let stream = self.call_stream(capability, request).await?;

        // When the stream is dropped, cancel the server-side work
        let cancel_token_clone = cancel_token.clone();
        tokio::spawn(async move {
            tokio::signal::ctrl_c().await;
            cancel_token_clone.cancel();
        });

        Ok((stream, cancel_token))
    }
}

// Server-side cancellation observation
async fn streaming_handler(
    request: Request,
    cancel: CancellationToken,
) -> impl Stream<Item = Result<Response, String>> {
    async_stream::try_stream! {
        for token in generate_tokens(&request) {
            // Check for cancellation before each token
            if cancel.is_cancelled() {
                yield Err("Cancelled by client".to_string());
                return;
            }
            yield Response::text(token);
        }
    }
}
```

---

## 4. Client-Streaming RPC Design

### 4.1 Pattern Definition

**Semantics**: Client sends multiple request frames, server sends one response after receiving all requests.

**Use Cases**:
- File upload in chunks
- Bulk data ingestion
- Telemetry batching
- Interactive REPL (send command, get output, send next)

### 4.2 Handler Signature

```rust
/// Client-streaming handler
pub type ClientStreamingHandlerFn = Arc<
    dyn Fn(impl Stream<Item = Result<Request, String>>, CancellationToken)
        -> Pin<Box<dyn Future<Output = Result<Response, String>> + Send>>
    + Send + Sync
>;

impl ServeBuilder {
    pub fn client_streaming_handler<F, Fut>(mut self, f: F) -> Self
    where
        F: Fn(impl Stream<Item = Result<Request, String>>, CancellationToken) -> Fut
            + Send + Sync + 'static,
        Fut: Future<Output = Result<Response, String>> + Send + 'static,
    {
        self.client_streaming_handler = Some(Arc::new(move |req_stream, cancel| {
            Box::pin(f(req_stream, cancel))
        }));
        self
    }
}
```

### 4.3 Client API

```rust
impl ConnectedAgent {
    /// Call with client streaming (multiple requests, one response)
    pub async fn call_client_stream(
        &self,
        capability: &str,
        requests: impl Stream<Item = Request>,
    ) -> Result<Response, SdkError> {
        let (mut send, mut recv) = conn.open_bi().await?;

        // Stream requests with MORE flag
        tokio::pin!(requests);
        let mut request_count = 0;

        while let Some(request) = requests.next().await {
            request_count += 1;
            let rpc_req = RpcRequest::new(request_count, "call").with_params(params);
            let req_bytes = rpc_req.encode()?;

            // Set MORE flag for all but the last request
            let more_flag = if requests.is_terminated() { 0 } else { flags::MORE };
            let req_frame = Frame {
                frame_type: FrameType::RpcRequest,
                flags: more_flag,
                stream_id: 0,
                extensions: vec![],
                payload: req_bytes,
            };

            let frame_bytes = encode_frame(&req_frame)?;
            send.write_all(&frame_bytes).await?;
        }

        // Send final request without MORE flag
        send.finish();

        // Read single response
        let (resp_frame, _) = decode_frame(&full_frame)?;
        let rpc_resp = RpcResponse::decode(&resp_frame.payload)?;

        Ok(Response::from(rpc_resp))
    }
}
```

### 4.4 Server-Side Implementation

```rust
// In ServeBuilder::start() handler loop
tokio::spawn(async move {
    let (mut send, mut recv) = conn.accept_bi().await?;

    // Read request stream
    let request_stream = async_stream::try_stream! {
        loop {
            let mut header = [0u8; FRAME_HEADER_SIZE];
            recv.read_exact(&mut header).await?;

            let (frame, _) = decode_frame(&full_frame)?;
            let rpc_req = RpcRequest::decode(&frame.payload)?;
            let request = Request::from(rpc_req);

            yield request;

            // If no MORE flag, this is the last request
            if !frame.has_more() {
                break;
            }
        }
    };

    // Call handler with request stream
    let cancel_token = CancellationToken::new();
    let response = (client_streaming_handler)(request_stream, cancel_token).await?;

    // Send single response
    let rpc_resp = RpcResponse::success(rpc_req.id, response_value);
    let resp_bytes = rpc_resp.encode()?;
    let resp_frame = Frame::data(0, resp_bytes);
    let frame_bytes = encode_frame(&resp_frame)?;
    send.write_all(&frame_bytes).await?;
    send.finish();
});
```

---

## 5. Bidirectional Streaming RPC Design

### 5.1 Pattern Definition

**Semantics**: Both client and server send multiple frames on the same bi-stream. The two streams operate independently.

**Use Cases**:
- Interactive REPL (send command, get output, send next, same session)
- Real-time collaboration
- Chat applications
- Interactive sessions with state

### 5.2 Handler Signature

```rust
/// Bidirectional streaming handler
pub type BidiStreamingHandlerFn = Arc<
    dyn Fn(
        impl Stream<Item = Result<Request, String>>,  // Incoming requests
        mpsc::Sender<Result<Response, String>>,      // Outgoing responses
        CancellationToken
    ) -> Pin<Box<dyn Future<Output = ()> + Send>>
    + Send + Sync
>;

impl ServeBuilder {
    pub fn bidi_streaming_handler<F, Fut>(mut self, f: F) -> Self
    where
        F: Fn(
            impl Stream<Item = Result<Request, String>>,
            mpsc::Sender<Result<Response, String>>,
            CancellationToken
        ) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        self.bidi_streaming_handler = Some(Arc::new(move |req_stream, resp_sender, cancel| {
            Box::pin(f(req_stream, resp_sender, cancel))
        }));
        self
    }
}
```

### 5.3 Client API

```rust
impl ConnectedAgent {
    /// Call with bidirectional streaming
    pub async fn call_bidi_stream(
        &self,
        capability: &str,
    ) -> Result<BidiSession, SdkError> {
        let (mut send, mut recv) = conn.open_bi().await?;

        let (req_sender, req_receiver) = mpsc::channel(100);
        let (resp_sender, resp_receiver) = mpsc::channel(100);

        // Spawn task to send requests
        let send_task = tokio::spawn(async move {
            let mut stream = req_receiver;
            let mut req_id = 0;

            while let Some(request) = stream.recv().await {
                req_id += 1;
                let rpc_req = RpcRequest::new(req_id, "call").with_params(params);
                let req_bytes = rpc_req.encode()?;

                // Always use MORE flag for bidi (never close send side)
                let req_frame = Frame {
                    frame_type: FrameType::RpcRequest,
                    flags: flags::MORE,
                    stream_id: 0,
                    extensions: vec![],
                    payload: req_bytes,
                };

                let frame_bytes = encode_frame(&req_frame)?;
                send.write_all(&frame_bytes).await?;
            }
        });

        // Spawn task to receive responses
        let recv_task = tokio::spawn(async move {
            loop {
                let mut header = [0u8; FRAME_HEADER_SIZE];
                recv.read_exact(&mut header).await?;

                let (frame, _) = decode_frame(&full_frame)?;
                let rpc_resp = RpcResponse::decode(&frame.payload)?;
                let response = Response::from(rpc_resp);

                resp_sender.send(Ok(response)).await?;
            }
        });

        Ok(BidiSession {
            requests: req_sender,
            responses: resp_receiver,
            send_task,
            recv_task,
        })
    }
}

pub struct BidiSession {
    pub requests: mpsc::Sender<Request>,
    pub responses: mpsc::Receiver<Result<Response, SdkError>>,
    send_task: JoinHandle<()>,
    recv_task: JoinHandle<()>,
}
```

### 5.4 Server-Side Implementation

```rust
// In ServeBuilder::start() handler loop
tokio::spawn(async move {
    let (mut send, mut recv) = conn.accept_bi().await?;

    let (req_sender, req_receiver) = mpsc::channel(100);
    let (resp_sender, resp_receiver) = mpsc::channel(100);

    // Spawn task to read incoming requests
    let recv_task = tokio::spawn(async move {
        let request_stream = async_stream::try_stream! {
            loop {
                let mut header = [0u8; FRAME_HEADER_SIZE];
                recv.read_exact(&mut header).await?;

                let (frame, _) = decode_frame(&full_frame)?;
                let rpc_req = RpcRequest::decode(&frame.payload)?;
                let request = Request::from(rpc_req);

                yield request;
            }
        };

        // Forward to handler
        tokio::pin!(request_stream);
        while let Some(request) = request_stream.next().await {
            req_sender.send(Ok(request)).await?;
        }
    });

    // Spawn task to send outgoing responses
    let send_task = tokio::spawn(async move {
        let mut stream = resp_receiver;
        while let Some(response) = stream.recv().await {
            let rpc_resp = RpcResponse::success(0, response_value);
            let resp_bytes = rpc_resp.encode()?;

            // Always use MORE flag for bidi
            let resp_frame = Frame {
                frame_type: FrameType::RpcResponse,
                flags: flags::MORE,
                stream_id: 0,
                extensions: vec![],
                payload: resp_bytes,
            };

            let frame_bytes = encode_frame(&resp_frame)?;
            send.write_all(&frame_bytes).await?;
        }
    });

    // Call handler with both directions
    let cancel_token = CancellationToken::new();
    (bidi_streaming_handler)(req_receiver, resp_sender, cancel_token).await;
});
```

---

## 6. Cancellation Mechanism

### 6.1 Multi-Layer Cancellation

**Three Levels of Cancellation**:

1. **Application-Level**: Handler observes `CancellationToken` and stops work
2. **Stream-Level**: QUIC stream reset (`QuicSendStream::reset()`) notifies peer
3. **Connection-Level**: Close connection via CLOSE frame (RFC-0002 §4.5)

### 6.2 Cancellation Flow

```
Client                              Server
  |                                   |
  |--- RPC_REQUEST (streaming) ------>|
  |                                   | [Handler starts work]
  |                                   |
  |--- STREAM_RESET(code=0) -------->| [QUIC notifies recv stream stopped]
  |                                   | [Handler observes cancel token]
  |                                   | [Handler aborts work]
  |                                   |
  |<-- RPC_RESPONSE(error) -----------|
  |                                   |
```

### 6.3 Implementation

```rust
use tokio_util::sync::CancellationToken;

/// Wrapper for QUIC streams with cancellation support
pub struct CancellableStream {
    send: QuicSendStream,
    recv: QuicRecvStream,
    cancel_token: CancellationToken,
}

impl CancellableStream {
    pub fn new(send: QuicSendStream, recv: QuicRecvStream) -> Self {
        let cancel_token = CancellationToken::new();
        Self { send, recv, cancel_token }
    }

    pub fn cancel_token(&self) -> &CancellationToken {
        &self.cancel_token
    }

    pub async fn cancel(&mut self) {
        self.cancel_token.cancel();
        self.send.reset(0); // QUIC stream reset
    }

    pub async fn send_with_cancel(&mut self, data: &[u8]) -> Result<(), Error> {
        // Check cancellation before sending
        if self.cancel_token.is_cancelled() {
            return Err(Error::Cancelled);
        }
        self.send.write_all(data).await?;
        Ok(())
    }
}
```

### 6.4 Handler Integration

```rust
// Handler receives cancellation token
async fn llm_generate_handler(
    request: Request,
    cancel: CancellationToken,
) -> impl Stream<Item = Result<Response, String>> {
    async_stream::try_stream! {
        for token in generate_tokens(&request) {
            // Check cancellation before each token
            cancel.cancelled().await;

            yield Response::text(token);
        }
    }
}
```

---

## 7. Backpressure Handling

### 7.1 QUIC Flow Control

**Current State**: QUIC handles flow control at the transport level automatically. When the receiver's buffer is full, QUIC stops sending data at the transport layer.

**Problem**: Application layer cannot observe flow control state. Handlers may generate data faster than the client can consume, leading to memory pressure.

### 7.2 Exposing Flow Control to Application

```rust
/// Stream context with flow control information
pub struct StreamContext {
    /// Number of bytes available in the send window
    pub send_window: u64,
    /// Whether the stream is write-blocked by flow control
    pub is_write_blocked: bool,
    /// Number of bytes buffered but not yet sent
    pub buffered_bytes: usize,
}

impl StreamContext {
    /// Wait until send window has at least `n` bytes available
    pub async fn wait_for_window(&self, n: u64) {
        while self.send_window < n {
            tokio::time::sleep(Duration::from_millis(10)).await;
            // Update send_window from QUIC
        }
    }
}

/// Handler receives stream context
async fn streaming_handler_with_backpressure(
    request: Request,
    cancel: CancellationToken,
    ctx: StreamContext,
) -> impl Stream<Item = Result<Response, String>> {
    async_stream::try_stream! {
        for chunk in generate_chunks(&request) {
            // Wait for flow control before sending
            ctx.wait_for_window(chunk.len() as u64).await;

            // Check cancellation
            if cancel.is_cancelled() {
                return;
            }

            yield Response::data(chunk);
        }
    }
}
```

### 7.3 Backpressure in Client API

```rust
impl ConnectedAgent {
    pub async fn call_stream_with_backpressure(
        &self,
        capability: &str,
        request: Request,
    ) -> Result<impl Stream<Item = Result<Response, SdkError>>, SdkError> {
        let (mut send, mut recv) = conn.open_bi().await?;

        let response_stream = async_stream::try_stream! {
            loop {
                // Read next frame (blocks if no data available)
                let frame = read_frame(&mut recv).await?;

                // QUIC flow control automatically blocks here
                // if the client's receive buffer is full

                let response = decode_response(&frame.payload)?;
                yield response;
            }
        };

        Ok(response_stream)
    }
}
```

---

## 8. Progress Updates

### 8.1 Interleaved Progress Frames

**Pattern**: Server sends progress frames interleaved with response frames on the same stream.

**Frame Differentiation**: Use a new flag or frame type to distinguish progress from data. Since wire protocol is frozen, use an extension or a special RPC response field.

**Option 1: Extension-based progress** (RFC-0006):
```rust
// Progress extension (type 0x0001)
pub struct ProgressExtension {
    pub progress_percent: u8,
    pub message: String,
}

// Send progress frame
let progress_ext = Extension::new(0x0001, progress_cbor);
let frame = Frame {
    frame_type: FrameType::RpcResponse,
    flags: flags::MORE,
    extensions: encode_extensions(&[progress_ext])?,
    payload: vec![], // Empty payload for progress-only frames
};
```

**Option 2: RPC response field** (no wire changes):
```rust
// Add "progress" field to RpcResponse
pub struct RpcResponse {
    pub id: u64,
    pub result: Option<Value>,
    pub error: Option<RpcErrorObject>,
    pub progress: Option<ProgressInfo>,  // New field
}

pub struct ProgressInfo {
    pub percent: u8,
    pub message: String,
}
```

### 8.2 Handler API

```rust
async fn long_task_handler(
    request: Request,
    cancel: CancellationToken,
    progress: mpsc::Sender<ProgressInfo>,  // Progress channel
) -> impl Stream<Item = Result<Response, String>> {
    async_stream::try_stream! {
        for step in 0..=100 {
            // Send progress update
            progress.send(ProgressInfo {
                percent: step,
                message: format!("Processing step {}", step),
            }).await?;

            // Do work
            do_work(step).await;

            // Check cancellation
            if cancel.is_cancelled() {
                return;
            }
        }

        // Send final result
        yield Response::text("Task complete");
    }
}
```

### 8.3 Client Progress Reception

```rust
impl ConnectedAgent {
    pub async fn call_with_progress(
        &self,
        capability: &str,
        request: Request,
    ) -> Result<(impl Stream<Item = Result<Response, SdkError>>,
                    impl Stream<Item = ProgressInfo>), SdkError> {
        let (mut send, mut recv) = conn.open_bi().await?;

        let (resp_sender, resp_receiver) = mpsc::channel(100);
        let (progress_sender, progress_receiver) = mpsc::channel(100);

        // Spawn receiver task
        tokio::spawn(async move {
            loop {
                let frame = read_frame(&mut recv).await?;

                // Check for progress extension
                if let Some(progress) = extract_progress_extension(&frame) {
                    progress_sender.send(progress).await?;
                } else {
                    // Regular response
                    let response = decode_response(&frame.payload)?;
                    resp_sender.send(Ok(response)).await?;
                }
            }
        });

        Ok((resp_receiver, progress_receiver))
    }
}
```

---

## 9. Comparison with gRPC, WebTransport, HTTP/3

### 9.1 gRPC Streaming

| Feature | gRPC | AAFP (proposed) |
|---------|------|-----------------|
| Server streaming | `rpc Method(Request) returns (stream Response)` | `streaming_handler(Request, CancellationToken) -> Stream<Response>` |
| Client streaming | `rpc Method(stream Request) returns (Response)` | `client_streaming_handler(Stream<Request>, CancellationToken) -> Response` |
| Bidirectional | `rpc Method(stream Request) returns (stream Response)` | `bidi_streaming_handler(Stream<Request>, Sender<Response>, CancellationToken)` |
| Cancellation | Context cancellation | QUIC stream reset + CancellationToken |
| Backpressure | HTTP/2 flow control | QUIC flow control (exposed via StreamContext) |
| Wire protocol | HTTP/2 + protobuf | QUIC + CBOR (no changes) |

**Key Difference**: gRPC uses HTTP/2 streams with protobuf message delimiters. AAFP uses QUIC streams with AAFP frame delimiters. Both support the same streaming patterns.

### 9.2 WebTransport

| Feature | WebTransport | AAFP (proposed) |
|---------|--------------|-----------------|
| Bidirectional streams | `createBidirectionalStream()` | `open_bi()` (already available) |
| Unidirectional streams | `createUnidirectionalStream()` | `open_uni()` (available but unused) |
| Server-initiated streams | `incomingBidirectionalStreams` | `accept_bi()` (already available) |
| Datagrams | `datagrams` API | Not yet exposed (QUIC supports datagrams) |
| Cancellation | Close readable/writable | Stream reset (available) |

**Key Difference**: WebTransport is a web API built on HTTP/3. AAFP is an application protocol built directly on QUIC. Both can use the same QUIC primitives.

### 9.3 HTTP/3 Server Push

| Feature | HTTP/3 | AAFP (proposed) |
|---------|--------|-----------------|
| Push mechanism | `PUSH_PROMISE` + push uni-stream | Server-initiated bi-stream or uni-stream |
| Client control | `MAX_PUSH_ID` frame | Capability negotiation (RFC-0006) |
| Cancellation | `CANCEL_PUSH` frame | Stream reset |
| Use case | Resource pre-fetching | Server-sent events, progress updates |

**Key Difference**: HTTP/3 server push is for resource pre-fetching (anticipatory). AAFP server-sent events are for reactive updates (in response to a subscription).

**AAFP Approach**: Use unidirectional streams for server-sent events (similar to HTTP/3 push streams) or bidirectional streams for interactive sessions.

---

## 10. Wire Protocol Compatibility

### 10.1 No Wire Changes Required

**Rationale**: The AAFP wire protocol (RFC-0002 Rev 6) is frozen. All streaming patterns can be implemented using existing frame types:

- **DATA frames (0x01)**: Carry application data (requests, responses, progress)
- **RPC_REQUEST (0x03)**: Carry RPC requests
- **RPC_RESPONSE (0x04)**: Carry RPC responses
- **MORE flag (0x01)**: Indicate more frames follow (repurposed for streaming)
- **Extensions (RFC-0006)**: Carry metadata (progress, streaming mode)

### 10.2 Streaming Mode Negotiation

**Option 1: Capability-based** (RFC-0006):
```rust
// Handshake capabilities include streaming methods
pub struct CapabilityDescriptor {
    pub name: String,
    pub streaming_mode: StreamingMode,  // Unary, ServerStream, ClientStream, Bidi
}

pub enum StreamingMode {
    Unary,           // Current behavior
    ServerStreaming, // One request, many responses
    ClientStreaming, // Many requests, one response
    BidiStreaming,   // Many requests, many responses
}
```

**Option 2: Method metadata in RPC**:
```rust
// Add "streaming" field to RpcRequest
pub struct RpcRequest {
    pub id: u64,
    pub method: String,
    pub params: Value,
    pub streaming: Option<StreamingMode>,  // New field
}
```

**Recommendation**: Use capability-based negotiation (Option 1) to keep RPC requests simple and allow per-method streaming configuration.

### 10.3 Backward Compatibility

**Unary RPCs (current behavior)**: Continue to work unchanged. Single request -> single response -> `send.finish()`.

**Streaming RPCs (new behavior)**: Opt-in via capability negotiation. Handler registered with streaming mode -> client calls `call_stream()` instead of `call()`.

**Mixed usage**: An agent can expose both unary and streaming capabilities. The simple API defaults to unary; new API methods expose streaming.

---

## 11. Implementation Roadmap

### 11.1 Phase 1: Server-Streaming (High Priority)

**Goal**: Enable LLM token streaming, progress updates, partial results.

**Work Items**:
1. Add `StreamingHandlerFn` type to `aafp-sdk/src/simple.rs`
2. Add `streaming_handler()` method to `ServeBuilder`
3. Add `call_stream()` method to `ConnectedAgent`
4. Modify handler loop to not call `send.finish()` immediately for streaming handlers
5. Implement response frame reading loop with MORE flag handling
6. Add `CancellationToken` to handler signature
7. Add QUIC stream reset on client drop

**Estimated Effort**: 3-5 days

**Files to Modify**:
- `aafp-sdk/src/simple.rs` (handler registration, client API)
- `aafp-messaging/src/rpc_v1.rs` (optional: add streaming metadata)
- `aafp-transport-quic/src/transport.rs` (expose stream reset)

### 11.2 Phase 2: Cancellation (High Priority)

**Goal**: Enable client-initiated cancellation of long-running tasks.

**Work Items**:
1. Add `CancellationToken` integration to all handler types
2. Implement `CancellableStream` wrapper
3. Add `cancel()` method to streaming client API
4. Map client drop to QUIC stream reset
5. Add cancellation observation in handler loop

**Estimated Effort**: 2-3 days

**Files to Modify**:
- `aafp-sdk/src/simple.rs` (cancellation token passing)
- `aafp-transport-quic/src/transport.rs` (stream reset exposure)

### 11.3 Phase 3: Client-Streaming (Medium Priority)

**Goal**: Enable file upload, bulk ingestion, interactive REPL.

**Work Items**:
1. Add `ClientStreamingHandlerFn` type
2. Add `client_streaming_handler()` method to `ServeBuilder`
3. Add `call_client_stream()` method to `ConnectedAgent`
4. Implement request frame reading loop with MORE flag handling
5. Aggregate requests before calling handler

**Estimated Effort**: 3-4 days

**Files to Modify**:
- `aafp-sdk/src/simple.rs` (handler registration, client API)

### 11.4 Phase 4: Bidirectional Streaming (Medium Priority)

**Goal**: Enable interactive sessions, real-time collaboration.

**Work Items**:
1. Add `BidiStreamingHandlerFn` type
2. Add `bidi_streaming_handler()` method to `ServeBuilder`
3. Add `call_bidi_stream()` method to `ConnectedAgent`
4. Implement `BidiSession` struct with request/response channels
5. Spawn separate tasks for send and receive directions

**Estimated Effort**: 4-5 days

**Files to Modify**:
- `aafp-sdk/src/simple.rs` (handler registration, client API, session management)

### 11.5 Phase 5: Backpressure Exposure (Low Priority)

**Goal**: Expose QUIC flow control state to handlers.

**Work Items**:
1. Add `StreamContext` struct
2. Query QUIC for send window size
3. Add `wait_for_window()` method
4. Pass `StreamContext` to handlers
5. Integrate with streaming handlers

**Estimated Effort**: 2-3 days

**Files to Modify**:
- `aafp-transport-quic/src/transport.rs` (expose flow control state)
- `aafp-sdk/src/simple.rs` (pass context to handlers)

### 11.6 Phase 6: Progress Updates (Low Priority)

**Goal**: Enable interleaved progress frames.

**Work Items**:
1. Define progress extension (RFC-0006) or RPC field
2. Add `ProgressInfo` struct
3. Add progress channel to handler signature
4. Implement progress frame encoding/decoding
5. Add progress reception to client API

**Estimated Effort**: 2-3 days

**Files to Modify**:
- `aafp-messaging/src/extensions.rs` (progress extension)
- `aafp-messaging/src/rpc_v1.rs` (progress field in RpcResponse)
- `aafp-sdk/src/simple.rs` (progress channel in handler)

---

## 12. Testing Strategy

### 12.1 Unit Tests

**Test Cases**:
- Server streaming: Send N frames with MORE, verify all received
- Client streaming: Send N frames with MORE, verify handler receives all
- Bidirectional: Concurrent send/receive, verify ordering
- Cancellation: Cancel mid-stream, verify handler stops
- Backpressure: Slow client, verify handler blocks
- Progress: Interleave progress and data frames, verify separation

**Test Files**:
- `aafp-tests/tests/streaming_server.rs`
- `aafp-tests/tests/streaming_client.rs`
- `aafp-tests/tests/streaming_bidi.rs`
- `aafp-tests/tests/streaming_cancel.rs`

### 12.2 Integration Tests

**Test Scenarios**:
- LLM token streaming (simulated)
- Long task with progress updates
- File upload in chunks
- Interactive REPL session
- Real-time collaboration (simulated)

**Test Files**:
- `aafp-tests/tests/streaming_integration.rs`

### 12.3 Conformance Tests

**Test Cases**:
- MORE flag semantics (fragmentation vs streaming)
- Stream reset behavior
- Flow control backpressure
- Extension encoding/decoding

**Test Files**:
- `aafp-conformance/src/streaming.rs`

---

## 13. Security Considerations

### 13.1 Resource Exhaustion

**Threat**: Malicious client opens many streaming connections, exhausting server memory.

**Mitigations**:
- Rate limit per-IP connection creation (already implemented in `aafp-sdk/src/server.rs`)
- Limit concurrent streams per connection (via `max_concurrent_streams` in `QuicConfig`)
- Limit buffer size per stream (via `stream_initial_max_data` in `QuicConfig`)
- Implement per-agent rate limiting for streaming methods

### 13.2 Cancellation Abuse

**Threat**: Client cancels and immediately reconnects, causing server to do work repeatedly.

**Mitigations**:
- Track cancellation rate per client
- Implement exponential backoff for repeated cancellations
- Cache partial results to avoid redoing work

### 13.3 Backpressure Attacks

**Threat**: Client never consumes data, causing server to buffer indefinitely.

**Mitigations**:
- QUIC flow control automatically blocks sender when receiver buffer is full
- Implement timeout for blocked sends
- Limit total buffered bytes per connection

### 13.4 Progress Frame Injection

**Threat**: Malicious client sends fake progress frames.

**Mitigations**:
- Only server can send progress frames (client ignores progress in requests)
- Validate progress extension format (RFC-0006)
- Rate limit progress frames

---

## 14. Performance Considerations

### 14.1 Memory Usage

**Current**: Each RPC allocates a new bi-stream, sends request, receives response, closes stream.

**Streaming**: Long-lived streams hold memory for the duration of the stream.

**Optimizations**:
- Reuse connection pool (already exists in `aafp-sdk/src/connection_pool.rs`, not used by simple API)
- Limit concurrent streaming connections per agent
- Use zero-copy frame decoding (already implemented in `aafp-messaging/src/framing.rs:466-562`)

### 14.2 Latency

**Current**: N round-trips for N polling requests (each requires new stream).

**Streaming**: Single round-trip for handshake, then streaming on same stream.

**Optimizations**:
- Use TLS session resumption (already implemented in `aafp-transport-quic/src/transport.rs:76-116`)
- Reuse connections for multiple streaming calls
- Use connection pool for simple API

### 14.3 Throughput

**Current**: Limited by per-request overhead (handshake, stream open/close).

**Streaming**: Higher throughput due to persistent stream and reduced overhead.

**Optimizations**:
- Tune `stream_initial_max_data` for larger windows
- Tune `max_ack_delay` for faster ACKs
- Use congestion controller (already implemented in `aafp-transport-quic/src/congestion.rs`)

---

## 15. API Ergonomics

### 15.1 Simple API (3-line developer experience)

**Current**:
```rust
Agent::serve()
    .capability("echo")
    .handler(|req| async move { Ok(Response::text(req.body())) })
    .start()
    .await?;
```

**Proposed Streaming API** (similar ergonomics):
```rust
Agent::serve()
    .capability("llm.generate")
    .streaming_handler(|req, cancel| async move {
        // Return a stream of responses
        async_stream::try_stream! {
            for token in generate_tokens(&req) {
                if cancel.is_cancelled() { break; }
                yield Response::text(token);
            }
        }
    })
    .start()
    .await?;
```

### 15.2 Client API

**Current**:
```rust
let agent = Agent::connect().connect().await?;
let result = agent.discover("echo").call(Request::text("hello")).await?;
```

**Proposed Streaming API**:
```rust
let agent = Agent::connect().connect().await?;
let mut stream = agent.discover("llm.generate")
    .call_stream(Request::text("write a poem"))
    .await?;

while let Some(token) = stream.next().await {
    print!("{}", token?.body());
}
```

### 15.3 Backward Compatibility

**Requirement**: Existing unary RPC code must continue to work without changes.

**Approach**:
- Add new methods (`streaming_handler`, `call_stream`) alongside existing methods
- Existing `handler` and `call` methods unchanged
- Default behavior remains unary (single request -> single response)
- Streaming is opt-in via method choice

---

## 16. Conclusion

### 16.1 Summary

AAFP's underlying QUIC transport already provides all the primitives needed for streaming RPC:
- Bidirectional streams (open_bi, accept_bi)
- Flow control (configurable via QuicConfig)
- Stream reset (for cancellation)
- MORE flag (for multi-frame messages)

The gap is entirely in the SDK layer (`aafp-sdk/src/simple.rs`), which currently exposes only a unary request-response pattern. By adding streaming handler types and client API methods, AAFP can support server-streaming, client-streaming, and bidirectional streaming without any wire protocol changes.

### 16.2 Recommendations

**Immediate (Phase 1-2)**:
1. Implement server-streaming RPC (highest priority for LLM token streaming)
2. Implement cancellation mechanism (high priority for long-running tasks)

**Short-term (Phase 3-4)**:
3. Implement client-streaming RPC (medium priority for file upload, REPL)
4. Implement bidirectional streaming (medium priority for interactive sessions)

**Long-term (Phase 5-6)**:
5. Expose backpressure to application layer (low priority, optimization)
6. Add progress update frames (low priority, nice-to-have)

### 16.3 Success Criteria

- [ ] Server streaming works for LLM token generation (8 sandbox tests pass)
- [ ] Cancellation stops server-side work (no orphaned tasks)
- [ ] Client streaming works for file upload (chunked upload)
- [ ] Bidirectional streaming works for interactive REPL
- [ ] No wire protocol changes required (RFC-0002 Rev 6 compatible)
- [ ] Backward compatible with existing unary RPC code
- [ ] Performance: Streaming reduces latency vs polling
- [ ] Security: Resource exhaustion mitigations in place

---

## Appendix A: Reference Implementations

### A.1 Server-Streaming Handler Example

```rust
use aafp_sdk::simple::{Agent, Request, Response};
use tokio_util::sync::CancellationToken;
use futures::stream::{Stream, StreamExt};

async fn start_llm_agent() -> ServingAgent {
    Agent::serve()
        .capability("llm.generate")
        .streaming_handler(|req: Request, cancel: CancellationToken| {
            async move {
                let prompt = req.body();
                let mut stream = async_stream::try_stream! {
                    for token in generate_tokens(prompt) {
                        // Check cancellation
                        if cancel.is_cancelled() {
                            yield Err("Cancelled by client".to_string());
                            return;
                        }
                        yield Response::text(token);
                    }
                };
                Ok(stream)
            }
        })
        .start()
        .await
        .expect("failed to start LLM agent")
}
```

### A.2 Client-Streaming Example

```rust
async fn upload_file(agent: &ConnectedAgent, chunks: Vec<Vec<u8>>) -> Result<Response, SdkError> {
    let chunk_stream = async_stream::stream! {
        for chunk in chunks {
            yield Request::data(chunk);
        }
    };

    agent.discover("file.upload")
        .call_client_stream(chunk_stream)
        .await
}
```

### A.3 Bidirectional Streaming Example

```rust
async fn interactive_repl(agent: &ConnectedAgent) -> Result<(), SdkError> {
    let mut session = agent.discover("repl")
        .call_bidi_stream()
        .await?;

    // Spawn task to handle responses
    let resp_task = tokio::spawn(async move {
        while let Some(response) = session.responses.next().await {
            println!("{}", response?.body());
        }
    });

    // Send commands from stdin
    let mut stdin = tokio::io::stdin();
    let mut line = String::new();
    while stdin.read_line(&mut line).await? > 0 {
        session.requests.send(Request::text(line.clone())).await?;
        line.clear();
    }

    resp_task.await?;
    Ok(())
}
```

---

## Appendix B: Frame Sequence Diagrams

### B.1 Server-Streaming RPC

```
Client                              Server
  |                                   |
  |--- RPC_REQUEST (id=1) ----------->|
  |                                   | [Handler starts]
  |                                   |
  |<-- RPC_RESPONSE(id=1, MORE) -----| [Token 1]
  |                                   |
  |<-- RPC_RESPONSE(id=1, MORE) -----| [Token 2]
  |                                   |
  |<-- RPC_RESPONSE(id=1, MORE) -----| [Token 3]
  |                                   |
  |<-- RPC_RESPONSE(id=1) -----------| [Token N, no MORE]
  |                                   | [Handler finishes]
  |                                   |
```

### B.2 Client-Streaming RPC

```
Client                              Server
  |                                   |
  |--- RPC_REQUEST(id=1, MORE) ------>|
  |                                   |
  |--- RPC_REQUEST(id=2, MORE) ------>|
  |                                   |
  |--- RPC_REQUEST(id=3) ------------>| [No MORE = last]
  |                                   | [Handler processes all]
  |                                   |
  |<-- RPC_RESPONSE(id=1) -----------| [Single response]
  |                                   |
```

### B.3 Bidirectional Streaming RPC

```
Client                              Server
  |                                   |
  |--- RPC_REQUEST(id=1, MORE) ------>|
  |                                   |
  |<-- RPC_RESPONSE(id=1, MORE) -----|
  |                                   |
  |--- RPC_REQUEST(id=2, MORE) ------>|
  |                                   |
  |<-- RPC_RESPONSE(id=2, MORE) -----|
  |                                   |
  |--- RPC_REQUEST(id=3, MORE) ------>|
  |                                   |
  |<-- RPC_RESPONSE(id=3, MORE) -----|
  |                                   |
  |--- STREAM_RESET ----------------->| [Cancellation]
  |                                   | [Handler stops]
  |                                   |
```

### B.4 Cancellation Flow

```
Client                              Server
  |                                   |
  |--- RPC_REQUEST (streaming) ------>|
  |                                   | [Handler starts work]
  |                                   |
  |--- STREAM_RESET(code=0) -------->| [QUIC notifies recv stopped]
  |                                   | [CancellationToken triggered]
  |                                   | [Handler observes cancel]
  |                                   | [Handler aborts work]
  |                                   |
  |<-- RPC_RESPONSE(error) -----------| [Error response]
  |                                   |
```

---

## Appendix C: Error Codes

### C.1 New Error Codes (RFC-0005)

Proposed new error codes for streaming:

| Code | Name | Description |
|------|------|-------------|
| 9001 | STREAMING_NOT_SUPPORTED | Method does not support streaming mode |
| 9002 | INVALID_STREAMING_MODE | Invalid streaming mode for method |
| 9003 | STREAM_CANCELLED | Stream was cancelled by peer |
| 9004 | STREAM_TIMEOUT | Stream operation timed out |
| 9005 | BACKPRESSURE_EXCEEDED | Client not consuming data fast enough |

### C.2 QUIC Stream Reset Codes

Map QUIC stream reset codes to AAFP error codes:

| QUIC Code | AAFP Error | Description |
|-----------|------------|-------------|
| 0 | 9003 | Cancelled by client |
| 1 | 9004 | Stream timeout |
| 2 | 9005 | Backpressure exceeded |

---

This design document provides a comprehensive roadmap for adding streaming RPC to AAFP using existing QUIC primitives with no wire protocol changes. The implementation is phased to prioritize the most critical use cases (LLM token streaming, cancellation) while maintaining backward compatibility with existing unary RPC code.
