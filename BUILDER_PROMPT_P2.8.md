# Builder Prompt: P2.8 — Server-Streaming RPC + Cancellation (Phase B1 + B2)

## Objective

Implement server-streaming RPC and handler cancellation in the AAFP Simple API.
This enables LLM token streaming, progress updates, and client-initiated
cancellation of long-running tasks — the two highest-priority streaming features.

## Prerequisites

- P2.7 (Simple API v2 Foundation) must be complete — this builds on the v2 types
  (HandlerContext, CancellationToken, Params, metadata).

## Context

Read these design documents before starting:
- `STREAMING_RPC_DESIGN.md` — Complete streaming RPC design (sections 3, 6)
- `SIMPLE_API_V2_DESIGN.md` — v2 API design (section 3 for streaming)
- `ADAPTATION_ROADMAP.md` — Priority matrix

## What to Build

### Part 1: Server-Streaming Handler (STREAMING_RPC_DESIGN.md §3)

Add `StreamingHandlerContext` and `ResponseSender`/`ResponseStream` types:

```rust
pub struct StreamingHandlerContext {
    pub cancel: CancellationToken,
    pub capability: String,
    pub sender: ResponseSender,
}

pub struct ResponseSender {
    inner: mpsc::Sender<Result<Response, SdkError>>,
}

pub struct ResponseStream {
    inner: mpsc::Receiver<Result<Response, SdkError>>,
}
```

Add `on_streaming()` to `ServeBuilder`:

```rust
pub fn on_streaming<F, Fut>(mut self, cap: impl Into<String>, f: F) -> Self
where
    F: Fn(Request, StreamingHandlerContext) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<(), SdkError>> + Send + 'static,
```

### Part 2: Server-Side Streaming Implementation

In the request handling loop, when a streaming handler is matched:
1. Create an `mpsc::channel(32)` for responses
2. Spawn the handler with `StreamingHandlerContext { sender, cancel, capability }`
3. Loop reading from the channel, encoding each response as an RPC_RESPONSE frame
4. Set the MORE flag on all frames except the last
5. Do NOT call `send.finish()` until the handler completes or channel closes
6. On handler error, send error frame and finish

### Part 3: Client-Side Streaming API

Add `call_streaming()` to `DiscoveryBuilder`:

```rust
pub async fn call_streaming(self, request: Request) -> Result<ResponseStream, SdkError>
```

Implementation:
1. Open bi-stream (same as call)
2. Send request frame
3. Do NOT call `send.finish()` — keep stream open for responses
4. Spawn a reader task that reads frames, decodes RPC responses, sends to mpsc channel
5. Return `ResponseStream` wrapping the channel receiver
6. When the ResponseStream is dropped, the reader task stops and the QUIC stream is reset

### Part 4: Handler Cancellation (STREAMING_RPC_DESIGN.md §6)

Wire up cancellation:
1. The `CancellationToken` in `HandlerContext`/`StreamingHandlerContext` is created per-request
2. Spawn a task that monitors the QUIC recv stream — when it closes (client disconnect),
   fire `cancel_token.cancel()`
3. In `tokio::select!`, race the handler future against `cancel_token.cancelled()`
4. On cancellation, stop the handler and close the send stream

### Part 5: Cancellation for Unary Handlers

Apply the same cancellation mechanism to unary (non-streaming) handlers:
1. Create `CancellationToken` for every request
2. Pass it via `HandlerContext`
3. Race handler against cancellation in the request loop
4. On cancel, abort handler and send error response (if stream still open)

### Part 6: Example + Tests

Create a streaming example:
```
examples/streaming-agent.rs
```

A server that streams "token_0", "token_1", ..., "token_9" with 100ms delay.
A client that connects and prints each token as it arrives.

Tests:
- `test_server_streaming_basic` — 10 frames received in order
- `test_server_streaming_cancellation` — client drops stream, server handler stops
- `test_streaming_handler_error` — handler returns error, client receives error frame
- `test_unary_cancellation` — unary handler cancelled on client disconnect
- `test_streaming_with_pool` — streaming over pooled connection

## Constraints

1. **No wire protocol changes.** Use existing RPC_REQUEST/RPC_RESPONSE frame types.
   The MORE flag (0x01) indicates more frames follow. This is already defined in
   RFC-0002 §4.1.

2. **Backward compatible.** Unary handlers (v1 and v2) continue to work. Streaming
   is opt-in via `on_streaming()`.

3. **Connection pool compatible.** Streaming calls should work over pooled
   connections. The stream stays open for the duration of the streaming response.

4. **Follow existing conventions.** Check `AGENTS.md`. Use `cargo fmt`, `cargo clippy`.

## Verification

```bash
cargo fmt --all -- --check   # 0 diffs
cargo build --workspace       # 0 errors, 0 warnings
cargo clippy --workspace      # 0 warnings
cargo test --workspace        # 1850+ tests, 0 failures
cargo run --example streaming-agent  # Shows tokens streaming
```

All existing examples must still work.

## Files to Modify

| File | Changes |
|------|---------|
| `crates/aafp-sdk/src/simple.rs` | StreamingHandlerContext, ResponseSender, ResponseStream, on_streaming(), call_streaming(), cancellation |
| `crates/aafp-sdk/src/lib.rs` | Re-export streaming types |
| `crates/aafp-sdk/tests/streaming.rs` | New streaming tests |
| `examples/streaming-agent.rs` | New streaming example |

## Success Criteria

- [ ] `on_streaming()` registers server-streaming handlers
- [ ] `call_streaming()` returns `ResponseStream` for consuming frames
- [ ] MORE flag set on all frames except the last
- [ ] Handler cancellation works (client disconnect → handler stops)
- [ ] Cancellation works for both streaming and unary handlers
- [ ] Streaming works over pooled connections
- [ ] `streaming-agent` example demonstrates token streaming
- [ ] All existing tests pass (1718+)
- [ ] New streaming tests pass (target 1850+ total)
- [ ] `cargo clippy` clean
- [ ] `cargo fmt` clean
