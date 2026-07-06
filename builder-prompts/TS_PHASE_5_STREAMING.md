# Builder Prompt: TypeScript SDK Phase 5 — v2 Streaming

**Target:** `@aafp/sdk` (pure-TypeScript AAFP SDK)
**Phase:** 5 of 8 (v2 streaming)
**Estimated effort:** 1-2 weeks
**Prerequisites:** Phases 1-4 complete (transport, handshake, CBOR framing, v2 unary handlers, connection pooling, failover discovery).

---

## Objective

Implement the v2 streaming API for the TypeScript SDK, exposing AAFP's QUIC
bidirectional streams and the MORE flag as idiomatic TypeScript async iterables.
Three streaming patterns must be supported: **server-streaming**, **client-streaming**,
and **bidirectional**. Cancellation flows through `AbortSignal` and maps to QUIC
stream reset. The wire protocol (RFC-0002 Rev 6) is frozen — no wire changes are
permitted; streaming is achieved by repurposing the existing MORE flag and
keeping bi-streams open.

The deliverable: LLM token streaming works via `for await`. Bidirectional chat
works. Cancellation propagates from client drop to server handler abort.

---

## Source Material

Read these design documents before implementing:

1. **`TYPESCRIPT_SDK_DESIGN.md`** §5.1 (handler types, `StreamingHandlerContext`),
   §5.3 (`ServeBuilder.onStreaming()` / `onBidirectional()`), §5.5
   (`DiscoveryBuilder.callStreaming()`), §5.8 (streaming usage examples),
   §7 (Phase 5 roadmap checklist).
2. **`STREAMING_RPC_DESIGN.md`** §3 (server-streaming), §4 (client-streaming),
   §5 (bidirectional), §6 (cancellation), §2 (MORE flag semantics), §10
   (wire compatibility — no changes required).
3. **`SIMPLE_API_V2_DESIGN.md`** §3 (streaming API: `ResponseSender`,
   `ResponseStream`, `StreamingHandlerContext`, `HandlerMode`, handler
   registration, server-side and client-side implementation).

---

## Files to Create / Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/streaming.ts` | **Create** | `StreamingHandlerContext`, `ResponseSender`, `ResponseStream`, `BidiSession`, `HandlerMode` |
| `src/types.ts` | **Modify** | Add `StreamingHandler`, `BidirectionalHandler`, `ClientStreamingHandler` type aliases |
| `src/serve.ts` | **Modify** | Add `onStreaming()`, `onBidirectional()`, `onClientStreaming()` to `ServeBuilder`; wire streaming dispatch into `ServingAgent` handler loop |
| `src/discovery.ts` | **Modify** | Add `callStreaming()`, `callClientStreaming()`, `callBidirectional()` to `DiscoveryBuilder` |
| `src/transport.ts` | **Modify** | Expose `reset()` on send stream, `stop()` on recv stream for cancellation |
| `src/framing.ts` | **Modify** | Add `StreamingMode` per-method metadata; MORE flag helpers (`withMore()`, `hasMore()`) |
| `tests/streaming-server.test.ts` | **Create** | Server-streaming integration test |
| `tests/streaming-client.test.ts` | **Create** | Client-streaming integration test |
| `tests/streaming-bidi.test.ts` | **Create** | Bidirectional integration test |
| `tests/streaming-cancel.test.ts` | **Create** | Cancellation integration test |
| `examples/streaming-v2.ts` | **Create** | End-to-end streaming example (token stream + chat) |

---

## Implementation Tasks

### Task 1: Core Streaming Types (`src/streaming.ts`)

Create the streaming primitives. These are the foundation for all three patterns.

#### 1.1 `StreamingHandlerContext`

Mirrors `aafp_sdk::simple::StreamingHandlerContext` from the Rust v2 design. The
context bundles a `ResponseSender`, an `AbortSignal` (the TS-native cancellation
primitive, replacing Rust's `CancellationToken`), and the capability name.

```typescript
// src/streaming.ts

import { Response } from "./types";
import { HandlerError } from "./errors";

/**
 * Streaming handler context — provides a response sender for streaming
 * handlers. Mirrors `aafp_sdk::simple::StreamingHandlerContext`.
 *
 * The AbortSignal fires when the client disconnects or cancels the stream
 * (via QUIC stream reset). Handlers SHOULD check `signal.aborted` or
 * `cancelled` before producing each chunk.
 */
export class StreamingHandlerContext {
  /** Fires when the client disconnects or cancels. */
  readonly signal: AbortSignal;
  /** The capability being invoked. */
  readonly capability: string;
  private readonly sender: ResponseSender;

  constructor(
    signal: AbortSignal,
    capability: string,
    sender: ResponseSender,
  ) {
    this.signal = signal;
    this.capability = capability;
    this.sender = sender;
  }

  /** Send a response chunk to the client. Rejects if the stream is closed. */
  async send(resp: Response): Promise<void> {
    await this.sender.send(resp);
  }

  /** Send an error frame and close the stream. */
  async error(err: HandlerError): Promise<void> {
    await this.sender.error(err);
  }

  /** Explicitly close the stream (no more responses). */
  async close(): Promise<void> {
    await this.sender.close();
  }

  /** True if the client has cancelled or disconnected. */
  get cancelled(): boolean {
    return this.signal.aborted;
  }
}
```

#### 1.2 `ResponseSender` class

The `ResponseSender` wraps the QUIC send stream. It encodes each `Response` as
an `RPC_RESPONSE` frame with the MORE flag set (unless it is the final frame),
writes it to the QUIC stream, and tracks whether the stream is still open. The
sender is owned by the server's handler loop; the `StreamingHandlerContext`
holds a reference and exposes `send()` / `error()` / `close()`.

```typescript
/**
 * Response sender — wraps the QUIC send stream for streaming handlers.
 * Encodes each Response as an RPC_RESPONSE frame with the MORE flag.
 *
 * Lifecycle:
 *   - send(resp):  write frame with MORE flag, keep stream open
 *   - error(err):  write error frame, then close stream
 *   - close():     write final frame without MORE, call send.finish()
 *
 * Mirrors `aafp_sdk::simple::ResponseSender` (Rust mpsc::Sender wrapper).
 */
export class ResponseSender {
  private readonly sendStream: QuicSendStream;
  private readonly rpcId: number;
  private closed = false;
  private readonly abortController: AbortController;

  constructor(
    sendStream: QuicSendStream,
    rpcId: number,
    abortController: AbortController,
  ) {
    this.sendStream = sendStream;
    this.rpcId = rpcId;
    this.abortController = abortController;
  }

  /** Send a response chunk (MORE flag set, stream stays open). */
  async send(resp: Response): Promise<void> {
    if (this.closed) {
      throw new Error("ResponseSender: stream already closed");
    }
    if (this.abortController.signal.aborted) {
      throw new Error("ResponseSender: stream cancelled by client");
    }
    const rpcResp = RpcResponse.success(this.rpcId, resp.toCborValue());
    const frame = Frame.data(0, rpcResp.encode()).withMore(); // MORE flag
    await this.sendStream.write(encodeFrame(frame));
  }

  /** Send an error frame and close the stream. */
  async error(err: HandlerError): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const rpcErr = RpcResponse.error(
      this.rpcId,
      RpcErrorObject.new(err.code, err.message),
    );
    const frame = Frame.data(0, rpcErr.encode()); // No MORE — final frame
    await this.sendStream.write(encodeFrame(frame));
    this.sendStream.finish();
  }

  /** Close the stream cleanly (final frame without MORE, then finish). */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.sendStream.finish(); // Half-close: no more data from server
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
```

#### 1.3 `ResponseStream` as `AsyncIterable`

The client-side `ResponseStream` implements `AsyncIterable<Response>` so it can
be consumed with `for await...of`. Internally it reads `RPC_RESPONSE` frames
from the QUIC recv stream, decodes each into a `Response`, and yields it. When a
frame without the MORE flag arrives (or the stream ends), the iterator
completes. Errors are thrown from the iterator body (caught by `for await`).

```typescript
/**
 * Response stream — client-side async iterable of Responses.
 * Implements AsyncIterable<Response> for `for await...of` consumption.
 *
 * Reads RPC_RESPONSE frames from the QUIC recv stream. Each frame with
 * the MORE flag yields a Response; a frame without MORE (or stream end)
 * terminates the iterator. Error frames throw a HandlerError.
 *
 * Mirrors `aafp_sdk::simple::ResponseStream` (Rust mpsc::Receiver wrapper),
 * adapted to TS async iterables instead of manual .next() polling.
 */
export class ResponseStream implements AsyncIterable<Response> {
  private readonly recvStream: QuicRecvStream;
  private readonly sendStream: QuicSendStream; // For cancellation reset
  private readonly signal: AbortSignal;
  private consumed = false;

  constructor(
    recvStream: QuicRecvStream,
    sendStream: QuicSendStream,
    signal: AbortSignal,
  ) {
    this.recvStream = recvStream;
    this.sendStream = sendStream;
    this.signal = signal;
  }

  /**
   * AsyncIterator implementation — called by `for await...of`.
   * Yields each Response chunk; throws HandlerError on error frames.
   * Terminates when a frame without MORE arrives or the stream ends.
   */
  async *[Symbol.asyncIterator](): AsyncIterator<Response> {
    if (this.consumed) {
      throw new Error("ResponseStream: already consumed");
    }
    this.consumed = true;

    try {
      while (true) {
        // Check for client-side cancellation
        if (this.signal.aborted) {
          this.sendStream.reset(0); // QUIC stream reset → server stops
          return;
        }

        // Read next frame (blocks until data available or stream ends)
        const frame = await readFrame(this.recvStream);
        if (frame === null) {
          // Stream ended (server called finish())
          return;
        }

        const rpcResp = RpcResponse.decode(frame.payload);

        if (rpcResp.isError()) {
          throw HandlerError.fromRpcError(rpcResp.error!);
        }

        const response = Response.fromRpcResult(rpcResp.result!);
        yield response;

        // If no MORE flag, this was the final frame
        if (!frame.hasMore()) {
          return;
        }
      }
    } finally {
      // Ensure stream is reset if consumer breaks out early
      if (!this.signal.aborted) {
        this.sendStream.reset(0);
      }
    }
  }

  /**
   * Cancel the stream (alternative to AbortSignal).
   * Resets the QUIC send stream, notifying the server to stop.
   */
  cancel(): void {
    this.sendStream.reset(0);
  }
}
```

#### 1.4 `BidiSession` class

The `BidiSession` is the client-side handle for bidirectional streaming. It
exposes a `send()` method for outgoing requests and is itself an
`AsyncIterable<Response>` for incoming responses. Internally it spawns two
concurrent operations: a sender that drains a request queue into the QUIC send
stream, and a receiver that reads response frames and buffers them for
iteration.

```typescript
/**
 * Bidirectional session — client-side handle for bidi streaming.
 *
 * Combines a request sender with a response async iterable. The caller
 * sends requests via .send() / .finish(), and consumes responses via
 * `for await...of` on the session itself.
 *
 * Mirrors `aafp_sdk::simple::BidiSession` (Rust mpsc channels), adapted
 * to TS async iterables.
 */
export class BidiSession implements AsyncIterable<Response> {
  private readonly sendStream: QuicSendStream;
  private readonly recvStream: QuicRecvStream;
  private readonly signal: AbortSignal;
  private readonly requestQueue: Request[] = [];
  private sendClosed = false;
  private responseBuffer: Response[] = [];
  private responseError: Error | null = null;
  private readonly responseWaiters: Array<() => void> = [];
  private iteratorStarted = false;

  constructor(
    sendStream: QuicSendStream,
    recvStream: QuicRecvStream,
    signal: AbortSignal,
  ) {
    this.sendStream = sendStream;
    this.recvStream = recvStream;
    this.signal = signal;
  }

  /** Send a request to the server (MORE flag always set for bidi). */
  send(req: Request): void {
    if (this.sendClosed) {
      throw new Error("BidiSession: send side already closed");
    }
    this.requestQueue.push(req);
    this.flushRequests();
  }

  /** Half-close the send side (no more requests). */
  finish(): void {
    this.sendClosed = true;
    this.flushRequests();
  }

  /** Cancel the entire session (resets both directions). */
  cancel(): void {
    this.sendStream.reset(0);
    this.recvStream.stop(0);
  }

  private async flushRequests(): Promise<void> {
    while (this.requestQueue.length > 0) {
      const req = this.requestQueue.shift()!;
      const rpcReq = RpcRequest.new(this.requestQueue.length, "call")
        .withParams(req.params.toValue());
      // Always MORE for bidi — stream stays open
      const frame = Frame.data(0, rpcReq.encode()).withMore();
      await this.sendStream.write(encodeFrame(frame));
    }
    if (this.sendClosed) {
      this.sendStream.finish(); // Signal no more requests
    }
  }

  /** AsyncIterator — yields responses as they arrive from the server. */
  async *[Symbol.asyncIterator](): AsyncIterator<Response> {
    if (this.iteratorStarted) {
      throw new Error("BidiSession: iterator already started");
    }
    this.iteratorStarted = true;

    // Spawn background reader task
    this.startReader();

    try {
      while (true) {
        if (this.signal.aborted) {
          this.cancel();
          return;
        }

        // Wait for a buffered response or error
        const resp = await this.nextResponse();
        if (resp === null) {
          // Stream ended
          return;
        }
        yield resp;
      }
    } finally {
      if (!this.signal.aborted) {
        this.cancel();
      }
    }
  }

  private async nextResponse(): Promise<Response | null> {
    if (this.responseBuffer.length > 0) {
      return this.responseBuffer.shift()!;
    }
    if (this.responseError) {
      throw this.responseError;
    }
    // Wait for reader to push a response
    await new Promise<void>((resolve) => this.responseWaiters.push(resolve));
    if (this.responseBuffer.length > 0) {
      return this.responseBuffer.shift()!;
    }
    if (this.responseError) {
      throw this.responseError;
    }
    return null; // Stream ended
  }

  private startReader(): void {
    (async () => {
      try {
        while (true) {
          const frame = await readFrame(this.recvStream);
          if (frame === null) break;

          const rpcResp = RpcResponse.decode(frame.payload);
          if (rpcResp.isError()) {
            this.responseError = HandlerError.fromRpcError(rpcResp.error!);
            break;
          }
          this.responseBuffer.push(
            Response.fromRpcResult(rpcResp.result!),
          );
          // Wake up a waiter
          const waiter = this.responseWaiters.shift();
          if (waiter) waiter();
        }
      } catch (e) {
        this.responseError = e as Error;
      } finally {
        // Wake all waiters (stream ended)
        while (this.responseWaiters.length > 0) {
          this.responseWaiters.shift()!();
        }
      }
    })();
  }
}
```

#### 1.5 `HandlerMode` enum

```typescript
/**
 * Handler mode — distinguishes unary, server-streaming, client-streaming,
 * and bidirectional handlers. Used for dispatch in the server handler loop
 * and for MORE flag interpretation (streaming vs fragmentation).
 *
 * Mirrors `aafp_sdk::simple::HandlerMode`.
 */
export enum HandlerMode {
  /** Unary request/response (v1 behavior). */
  Unary = "unary",
  /** Server streaming: one request → many responses. */
  ServerStreaming = "server_streaming",
  /** Client streaming: many requests → one response. */
  ClientStreaming = "client_streaming",
  /** Bidirectional: many requests ↔ many responses. */
  Bidirectional = "bidirectional",
}
```

---

### Task 2: Handler Type Aliases (`src/types.ts`)

Add the streaming handler type aliases alongside the existing `CapabilityHandler`:

```typescript
/**
 * v2 server-streaming handler: receives Request + StreamingHandlerContext,
 * streams responses via ctx.send(). Throws HandlerError on failure.
 * Resolves when streaming is complete.
 */
export type StreamingHandler =
  (req: Request, ctx: StreamingHandlerContext) => Promise<void>;

/**
 * v2 client-streaming handler: receives an AsyncIterable<Request> +
 * HandlerContext, returns a single Response. Throws HandlerError on failure.
 */
export type ClientStreamingHandler =
  (requests: AsyncIterable<Request>, ctx: HandlerContext) => Promise<Response>;

/**
 * v2 bidirectional handler: receives an AsyncIterable<Request> +
 * StreamingHandlerContext, streams responses via ctx.send().
 * Throws HandlerError on failure.
 */
export type BidirectionalHandler =
  (requests: AsyncIterable<Request>, ctx: StreamingHandlerContext) => Promise<void>;
```

---

### Task 3: Server-Side Handler Registration (`src/serve.ts`)

#### 3.1 `onStreaming()` — server-streaming handler registration

Register a handler that receives one `Request` and streams multiple `Response`
chunks via `ctx.send()`. The handler loop keeps the bi-stream open until the
handler resolves or the client cancels.

```typescript
export class ServeBuilder {
  private opts: ServeOptions = {
    capabilities: [],
    capabilityHandlers: new Map(),
    streamingHandlers: new Map(),
    clientStreamingHandlers: new Map(),
    bidiHandlers: new Map(),
    fallbackHandler: null,
  };

  /**
   * Register a server-streaming handler (v2).
   * The handler receives a Request and a StreamingHandlerContext with a
   * send() method for streaming responses to the client.
   *
   * Wire behavior: the server does NOT call send.finish() after the first
   * response. It writes RPC_RESPONSE frames with the MORE flag until the
   * handler resolves, then writes a final frame without MORE and finishes.
   */
  onStreaming(cap: string, handler: StreamingHandler): this {
    this.opts.streamingHandlers.set(cap, handler);
    if (!this.opts.capabilities.includes(cap)) {
      this.opts.capabilities.push(cap);
    }
    return this;
  }

  /**
   * Register a bidirectional streaming handler (v2).
   * The handler receives an AsyncIterable<Request> and a StreamingHandlerContext.
   * The client can send multiple requests; the server streams responses.
   *
   * Wire behavior: both directions stay open. The server reads request frames
   * (each with MORE) and feeds them to the handler as an async iterable.
   * Responses are sent with MORE until the handler resolves.
   */
  onBidirectional(cap: string, handler: BidirectionalHandler): this {
    this.opts.bidiHandlers.set(cap, handler);
    if (!this.opts.capabilities.includes(cap)) {
      this.opts.capabilities.push(cap);
    }
    return this;
  }

  /**
   * Register a client-streaming handler (v2).
   * The handler receives an AsyncIterable<Request> and returns a single Response.
   *
   * Wire behavior: the client sends multiple request frames with MORE, then
   * finishes the send side. The server reads all requests, calls the handler,
   * and sends a single response frame.
   */
  onClientStreaming(cap: string, handler: ClientStreamingHandler): this {
    this.opts.clientStreamingHandlers.set(cap, handler);
    if (!this.opts.capabilities.includes(cap)) {
      this.opts.capabilities.push(cap);
    }
    return this;
  }
}
```

#### 3.2 Streaming dispatch in the handler loop

The `ServingAgent` handler loop must detect the handler mode for the incoming
capability and branch accordingly. The dispatch logic:

```typescript
// In ServingAgent.handleBidiStream():
const capability = rpcReq.method;
const cancelController = new AbortController();

// Wire QUIC recv stream stop → AbortSignal (client disconnect detection)
recvStream.onStop((code) => {
  cancelController.abort();
});

// Determine handler mode
const streamingHandler = this.streamingHandlers.get(capability);
const clientStreamingHandler = this.clientStreamingHandlers.get(capability);
const bidiHandler = this.bidiHandlers.get(capability);
const unaryHandler = this.capabilityHandlers.get(capability)
  ?? this.fallbackHandler;

if (streamingHandler) {
  // ─── Server-streaming ──────────────────────────────────────
  const sender = new ResponseSender(sendStream, rpcReq.id, cancelController);
  const ctx = new StreamingHandlerContext(
    cancelController.signal,
    capability,
    sender,
  );
  try {
    await streamingHandler(request, ctx);
    await sender.close(); // Final frame without MORE, then finish
  } catch (e) {
    await sender.error(HandlerError.from(e));
  }
} else if (bidiHandler) {
  // ─── Bidirectional ─────────────────────────────────────────
  const sender = new ResponseSender(sendStream, rpcReq.id, cancelController);
  const ctx = new StreamingHandlerContext(
    cancelController.signal,
    capability,
    sender,
  );
  // Create async iterable of incoming requests from the recv stream
  const requestIterable = createRequestIterable(recvStream, cancelController.signal);
  try {
    await bidiHandler(requestIterable, ctx);
    await sender.close();
  } catch (e) {
    await sender.error(HandlerError.from(e));
  }
} else if (clientStreamingHandler) {
  // ─── Client-streaming ──────────────────────────────────────
  const requestIterable = createRequestIterable(recvStream, cancelController.signal);
  const ctx = new HandlerContext(cancelController.signal, capability);
  try {
    const response = await clientStreamingHandler(requestIterable, ctx);
    const rpcResp = RpcResponse.success(rpcReq.id, response.toCborValue());
    const frame = Frame.data(0, rpcResp.encode()); // No MORE — single response
    await sendStream.write(encodeFrame(frame));
    sendStream.finish();
  } catch (e) {
    const err = HandlerError.from(e);
    const rpcErr = RpcResponse.error(rpcReq.id, RpcErrorObject.new(err.code, err.message));
    await sendStream.write(encodeFrame(Frame.data(0, rpcErr.encode())));
    sendStream.finish();
  }
} else if (unaryHandler) {
  // ─── Unary (v1/v2, existing behavior) ──────────────────────
  // ... existing unary dispatch ...
} else {
  // Unknown capability
  const rpcErr = RpcResponse.error(rpcReq.id, RpcErrorObject.new(5001, "unknown method"));
  await sendStream.write(encodeFrame(Frame.data(0, rpcErr.encode())));
  sendStream.finish();
}
```

#### 3.3 `createRequestIterable` helper

Converts the QUIC recv stream into an `AsyncIterable<Request>` for
client-streaming and bidirectional handlers:

```typescript
/**
 * Create an AsyncIterable<Request> from a QUIC recv stream.
 * Reads RPC_REQUEST frames with MORE flag, yields each as a Request.
 * Terminates when a frame without MORE arrives or the stream ends.
 */
function createRequestIterable(
  recvStream: QuicRecvStream,
  signal: AbortSignal,
): AsyncIterable<Request> {
  return {
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (signal.aborted) return;
        const frame = await readFrame(recvStream);
        if (frame === null) return;
        const rpcReq = RpcRequest.decode(frame.payload);
        yield Request.fromRpc(rpcReq);
        if (!frame.hasMore()) return;
      }
    },
  };
}
```

---

### Task 4: Client-Side Streaming Methods (`src/discovery.ts`)

#### 4.1 `callStreaming()` — server-streaming client

Returns an `AsyncIterable<Response>`. Opens a bi-stream, sends the request
frame (without calling `send.finish()` — the send side stays open for
cancellation via reset), and returns a `ResponseStream` that reads response
frames.

```typescript
export class DiscoveryBuilder {
  /**
   * Discover an agent and start a server-streaming call (v2).
   * Returns an AsyncIterable<Response> that yields chunks as they arrive.
   *
   * Wire behavior: opens bi-stream, sends request frame, does NOT call
   * send.finish() (keeps send side open for cancellation reset). Reads
   * response frames with MORE flag until a frame without MORE arrives.
   */
  async callStreaming(
    request: Request,
    opts?: CallOptions,
  ): Promise<AsyncIterable<Response>> {
    const candidates = await this.client.findByCapability(this.capability);
    if (candidates.length === 0) {
      throw new AafpError(
        AafpErrorCode.NoAgentsFound,
        `no agents found for capability '${this.capability}'`,
      );
    }

    // For streaming, we don't failover mid-stream — pick the first reachable
    const addr = candidates[0].endpoints[0];
    const conn = await this.pool.getOrConnect(addr);

    // Open bi-stream
    const [sendStream, recvStream] = await conn.openBi();

    // Send request frame (do NOT finish — keep open for cancel reset)
    const rpcReq = RpcRequest.new(1, this.capability)
      .withParams(request.params.toValue());
    const frame = Frame.data(0, rpcReq.encode());
    await sendStream.write(encodeFrame(frame));

    // Create AbortController for cancellation
    const controller = new AbortController();
    if (opts?.signal) {
      // Link external signal to our controller
      opts.signal.addEventListener("abort", () => controller.abort());
    }

    return new ResponseStream(recvStream, sendStream, controller.signal);
  }
}
```

#### 4.2 `callBidirectional()` — bidirectional client

Returns a `BidiSession` that is both a request sender and a response
`AsyncIterable`:

```typescript
export class DiscoveryBuilder {
  /**
   * Discover an agent and start a bidirectional streaming call (v2).
   * Returns a BidiSession with .send() for requests and async iterable
   * for responses.
   */
  async callBidirectional(
    opts?: CallOptions,
  ): Promise<BidiSession> {
    const candidates = await this.client.findByCapability(this.capability);
    if (candidates.length === 0) {
      throw new AafpError(
        AafpErrorCode.NoAgentsFound,
        `no agents found for capability '${this.capability}'`,
      );
    }

    const addr = candidates[0].endpoints[0];
    const conn = await this.pool.getOrConnect(addr);
    const [sendStream, recvStream] = await conn.openBi();

    const controller = new AbortController();
    if (opts?.signal) {
      opts.signal.addEventListener("abort", () => controller.abort());
    }

    return new BidiSession(sendStream, recvStream, controller.signal);
  }
}
```

#### 4.3 `callClientStreaming()` — client-streaming client

Sends multiple request frames, receives one response:

```typescript
export class DiscoveryBuilder {
  /**
   * Discover an agent and start a client-streaming call (v2).
   * Sends an async iterable of requests, receives a single Response.
   */
  async callClientStreaming(
    requests: AsyncIterable<Request>,
    opts?: CallOptions,
  ): Promise<Response> {
    const candidates = await this.client.findByCapability(this.capability);
    if (candidates.length === 0) {
      throw new AafpError(AafpErrorCode.NoAgentsFound, "no agents found");
    }

    const addr = candidates[0].endpoints[0];
    const conn = await this.pool.getOrConnect(addr);
    const [sendStream, recvStream] = await conn.openBi();

    // Stream requests with MORE flag
    let reqId = 0;
    for await (const req of requests) {
      reqId++;
      const rpcReq = RpcRequest.new(reqId, this.capability)
        .withParams(req.params.toValue());
      const frame = Frame.data(0, rpcReq.encode()).withMore();
      await sendStream.write(encodeFrame(frame));
    }
    sendStream.finish(); // No more requests

    // Read single response
    const frame = await readFrame(recvStream);
    const rpcResp = RpcResponse.decode(frame!.payload);
    if (rpcResp.isError()) {
      throw HandlerError.fromRpcError(rpcResp.error!);
    }
    return Response.fromRpcResult(rpcResp.result!);
  }
}
```

---

### Task 5: MORE Flag Handling — Streaming vs Fragmentation Mode

The MORE flag (0x01) has two interpretations depending on the handler mode:

1. **Fragmentation mode (existing, unary):** When a single RPC payload exceeds
   1 MiB, it is split across multiple DATA frames with MORE. The receiver
   buffers and reassembles before delivering to the application. This is the
   current v1 behavior — do not change it.

2. **Streaming mode (new):** When the method is registered as a streaming
   handler, each DATA frame with MORE is a **complete application message**,
   not a fragment. The receiver delivers each frame immediately without
   reassembly.

**Distinguishing the modes:** The mode is determined by the handler
registration on the server side (`streamingHandlers` / `bidiHandlers` /
`clientStreamingHandlers` maps). The client knows the mode because it called
`callStreaming()` / `callBidirectional()` / `callClientStreaming()` explicitly.
No wire-level negotiation is needed — the interpretation is a local decision
based on which API method was used.

**Implementation in `src/framing.ts`:**

```typescript
export const MORE_FLAG = 0x01;

export class Frame {
  // ... existing fields ...

  /** Set the MORE flag (more frames follow). */
  withMore(): this {
    this.flags |= MORE_FLAG;
    return this;
  }

  /** Check if the MORE flag is set. */
  hasMore(): boolean {
    return (this.flags & MORE_FLAG) !== 0;
  }
}

/**
 * Read frames in streaming mode — each frame is a complete message.
 * Used by ResponseStream and BidiSession.
 */
export async function readFrame(
  recv: QuicRecvStream,
): Promise<Frame | null> {
  // Read 28-byte frame header
  const header = await recv.readExact(FRAME_HEADER_SIZE);
  if (header === null) return null; // Stream ended

  const { frameType, flags, payloadLength } = decodeFrameHeader(header);
  const payload = await recv.readExact(payloadLength);

  return new Frame(frameType, flags, 0, [], payload);
}

/**
 * Read frames in fragmentation mode — reassemble fragments.
 * Used by the unary handler path for large payloads (>1 MiB).
 * Buffers frames with MORE until a frame without MORE arrives.
 */
export async function readReassembledFrame(
  recv: QuicRecvStream,
): Promise<Frame | null> {
  let buffer: Uint8Array | null = null;
  let lastFrame: Frame;

  while (true) {
    const frame = await readFrame(recv);
    if (frame === null) return null;

    if (buffer === null) {
      buffer = frame.payload;
    } else {
      const combined = new Uint8Array(buffer.length + frame.payload.length);
      combined.set(buffer);
      combined.set(frame.payload, buffer.length);
      buffer = combined;
    }

    if (!frame.hasMore()) {
      // Final fragment — return reassembled frame
      return new Frame(frame.frameType, 0, 0, [], buffer);
    }
    // Continue reading fragments
  }
}
```

**Key rule:** The streaming code paths (`ResponseStream`, `BidiSession`,
`createRequestIterable`) use `readFrame()` (no reassembly). The unary code path
uses `readReassembledFrame()` (with reassembly). Never mix the two on the same
stream.

---

### Task 6: Cancellation via AbortSignal + QUIC Stream Reset

Cancellation operates at three levels, mirroring `STREAMING_RPC_DESIGN.md` §6:

1. **Application-level:** The handler observes `ctx.signal.aborted` (or
   `ctx.cancelled`) and stops producing chunks.
2. **Stream-level:** When the client drops the async iterator (e.g., `break`
   in a `for await` loop) or calls `stream.cancel()`, the QUIC send stream is
   reset (`sendStream.reset(0)`). This notifies the server's recv stream via
   `onStop()`, which fires the `AbortController`.
3. **Connection-level:** Closing the connection (via CLOSE frame) cancels all
   streams on that connection.

#### 6.1 Client-side cancellation

The `ResponseStream` and `BidiSession` both reset the send stream in their
`finally` blocks when the consumer breaks out of `for await` early. This is
the primary cancellation path — no explicit `cancel()` call is needed if the
consumer simply stops iterating:

```typescript
// Client breaks out early → triggers finally → sendStream.reset(0)
for await (const chunk of stream) {
  console.log(chunk.body);
  if (chunk.body === "token_5") break; // Cancel after 6 tokens
}
// Server handler sees ctx.cancelled === true and stops
```

The `CallOptions.signal` (an `AbortSignal` passed by the caller) links to the
internal `AbortController`:

```typescript
const controller = new AbortController();
if (opts?.signal) {
  opts.signal.addEventListener("abort", () => controller.abort());
}
```

#### 6.2 Server-side cancellation observation

The server wires the QUIC recv stream's `onStop` callback to the
`AbortController`:

```typescript
// In ServingAgent.handleBidiStream():
recvStream.onStop((code: number) => {
  cancelController.abort();
  // The handler's ctx.signal is now aborted
});
```

The handler checks `ctx.cancelled` before each chunk:

```typescript
async (req: Request, ctx: StreamingHandlerContext) => {
  for (let i = 0; i < 1000; i++) {
    if (ctx.cancelled) {
      console.log("Cancelled by client");
      return;
    }
    await ctx.send(Response.text(`token_${i}`));
    await sleep(100);
  }
}
```

#### 6.3 Cancellation flow diagram

```
Client                              Server
  |                                   |
  |--- RPC_REQUEST (streaming) ------>|
  |                                   | [Handler starts, ctx.signal ready]
  |                                   |
  | [consumer breaks for await]       |
  |--- STREAM_RESET(code=0) -------->| [recv onStop fires → abort controller]
  |                                   | [Handler sees ctx.cancelled → stops]
  |                                   | [Sender closes stream]
  |<-- (stream closed) ---------------|
```

---

### Task 7: Integration Tests

Create four test files covering each streaming pattern plus cancellation.

#### 7.1 Server-streaming test (`tests/streaming-server.test.ts`)

```typescript
import { Agent, Request, Response } from "../src";

test("server-streaming: token stream", async () => {
  const server = await Agent.serve()
    .capability("token_stream")
    .onStreaming("token_stream", async (req, ctx) => {
      for (let i = 0; i < 5; i++) {
        if (ctx.cancelled) return;
        await ctx.send(Response.text(`token_${i}`));
      }
    })
    .bind("127.0.0.1:0")
    .start();

  const client = await Agent.connect();
  const stream = await client.discover("token_stream")
    .callStreaming(Request.text("start"));

  const tokens: string[] = [];
  for await (const chunk of stream) {
    tokens.push(chunk.body);
  }
  expect(tokens).toEqual(["token_0", "token_1", "token_2", "token_3", "token_4"]);

  await server.stop();
});
```

#### 7.2 Cancellation test (`tests/streaming-cancel.test.ts`)

```typescript
test("streaming cancellation: break early resets stream", async () => {
  const server = await Agent.serve()
    .capability("long_stream")
    .onStreaming("long_stream", async (req, ctx) => {
      for (let i = 0; i < 1000; i++) {
        if (ctx.cancelled) return; // Should stop here
        await ctx.send(Response.text(`item_${i}`));
        await sleep(10);
      }
    })
    .bind("127.0.0.1:0")
    .start();

  const client = await Agent.connect();
  const stream = await client.discover("long_stream")
    .callStreaming(Request.text("go"));

  let count = 0;
  for await (const chunk of stream) {
    count++;
    if (count === 5) break; // Cancel after 5 chunks
  }
  expect(count).toBe(5);
  // Server handler should have stopped (no hang)

  await server.stop();
});
```

#### 7.3 Bidirectional test (`tests/streaming-bidi.test.ts`)

```typescript
test("bidirectional: chat session", async () => {
  const server = await Agent.serve()
    .capability("chat")
    .onBidirectional("chat", async (requests, ctx) => {
      for await (const req of requests) {
        if (ctx.cancelled) return;
        await ctx.send(Response.text(`You said: ${req.body}`));
      }
    })
    .bind("127.0.0.1:0")
    .start();

  const client = await Agent.connect();
  const bidi = await client.discover("chat").callBidirectional();

  bidi.send(Request.text("hello"));
  bidi.send(Request.text("how are you?"));
  bidi.finish();

  const replies: string[] = [];
  for await (const resp of bidi) {
    replies.push(resp.body);
  }
  expect(replies).toEqual(["You said: hello", "You said: how are you?"]);

  await server.stop();
});
```

#### 7.4 Client-streaming test (`tests/streaming-client.test.ts`)

```typescript
test("client-streaming: upload chunks", async () => {
  const server = await Agent.serve()
    .capability("upload")
    .onClientStreaming("upload", async (requests, ctx) => {
      let total = 0;
      for await (const req of requests) {
        total += parseInt(req.body, 10);
      }
      return Response.text(`Total: ${total}`);
    })
    .bind("127.0.0.1:0")
    .start();

  const client = await Agent.connect();
  async function* generateChunks() {
    yield Request.text("10");
    yield Request.text("20");
    yield Request.text("30");
  }

  const result = await client.discover("upload")
    .callClientStreaming(generateChunks());

  expect(result.body).toBe("Total: 60");
  await server.stop();
});
```

---

### Task 8: End-to-End Example (`examples/streaming-v2.ts`)

Create a runnable example demonstrating all three streaming patterns:

```typescript
// examples/streaming-v2.ts
import { Agent, Request, Response } from "@aafp/sdk";

async function main() {
  // ─── Server: token streaming via onStreaming ────────────────
  const server = await Agent.serve()
    .capability("token_stream")
    .onStreaming("token_stream", async (req, ctx) => {
      for (let i = 0; i < 10; i++) {
        if (ctx.cancelled) {
          console.log("Streaming cancelled by client");
          return;
        }
        await ctx.send(Response.text(`token_${i}`));
        await sleep(100);
      }
    })
    .capability("chat")
    .onBidirectional("chat", async (requests, ctx) => {
      for await (const req of requests) {
        if (ctx.cancelled) return;
        const reply = `You said: ${req.body}`;
        await ctx.send(Response.text(reply));
      }
    })
    .start();

  // ─── Client: consume server-streaming via async iterable ────
  const client = await Agent.connect();
  const stream = await client.discover("token_stream")
    .callStreaming(Request.text("start"));

  for await (const chunk of stream) {
    process.stdout.write(chunk.body + " ");
  }
  console.log();

  // ─── Client: bidirectional streaming ────────────────────────
  const bidi = await client.discover("chat").callBidirectional();
  bidi.send(Request.text("hello"));
  bidi.send(Request.text("how are you?"));
  bidi.finish();

  for await (const resp of bidi) {
    console.log(resp.body);
  }

  await server.stop();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch(console.error);
```

---

## Acceptance Criteria

- [ ] `StreamingHandlerContext` with `signal` (AbortSignal), `capability`,
      `send()`, `error()`, `close()`, `cancelled` getter.
- [ ] `ResponseSender` class with `.send()`, `.error()`, `.close()` — encodes
      frames with MORE flag, manages stream lifecycle.
- [ ] `ResponseStream` implements `AsyncIterable<Response>` — consumable via
      `for await...of`, terminates on final frame or stream end.
- [ ] `BidiSession` implements `AsyncIterable<Response>` with `.send()` and
      `.finish()` for outgoing requests.
- [ ] `onStreaming()` on `ServeBuilder` — registers server-streaming handlers.
- [ ] `onBidirectional()` on `ServeBuilder` — registers bidi handlers.
- [ ] `onClientStreaming()` on `ServeBuilder` — registers client-streaming
      handlers.
- [ ] `callStreaming()` on `DiscoveryBuilder` — returns
      `Promise<AsyncIterable<Response>>`.
- [ ] `callBidirectional()` on `DiscoveryBuilder` — returns
      `Promise<BidiSession>`.
- [ ] `callClientStreaming()` on `DiscoveryBuilder` — accepts
      `AsyncIterable<Request>`, returns `Promise<Response>`.
- [ ] MORE flag: streaming mode delivers each frame immediately; fragmentation
      mode reassembles. The two modes never mix on the same stream.
- [ ] Cancellation: client `break` in `for await` triggers QUIC stream reset;
      server handler sees `ctx.cancelled === true` and stops.
- [ ] `CallOptions.signal` (external `AbortSignal`) links to internal
      cancellation.
- [ ] Server handler loop dispatches correctly based on handler mode (unary
      vs server-streaming vs client-streaming vs bidi).
- [ ] All four integration tests pass (server-streaming, client-streaming,
      bidi, cancellation).
- [ ] `examples/streaming-v2.ts` runs end-to-end without errors.
- [ ] Backpressure: QUIC flow control is respected (stream window); no
      unbounded buffering in `BidiSession` response buffer (cap at 32, then
      backpressure the reader).

---

## Design Constraints

1. **No wire protocol changes.** RFC-0002 Rev 6 is frozen. Streaming uses
   existing frame types (DATA / RPC_REQUEST / RPC_RESPONSE) and the existing
   MORE flag (0x01). The interpretation (streaming vs fragmentation) is a
   local decision based on handler mode, not a wire-level negotiation.

2. **Async iterables, not callbacks.** The TS SDK uses `AsyncIterable<T>` and
   `for await...of` as the idiomatic streaming primitive — not Node.js
   `EventEmitter`, not callback-based `on("data")`. This matches the design
   doc's directive: "streaming via async iterables, which are first-class in
   TS."

3. **AbortSignal, not CancellationToken.** The TS SDK uses the standard
   `AbortController` / `AbortSignal` (Web API) instead of Rust's
   `tokio_util::sync::CancellationToken`. This is the JS-native equivalent and
   is supported in Node.js, Deno, Bun, and browsers.

4. **v1 backward compatibility.** Unary handlers (registered via
   `onCapability()` or the deprecated `handler()`) continue to work
   unchanged — single request, single response, `send.finish()` after
   response. The streaming code paths are entirely separate.

5. **No mid-stream failover.** `callStreaming()` and `callBidirectional()`
   pick the first reachable candidate and do not failover mid-stream (you
   cannot resume a stream on a different connection). Failover happens only
   at connection establishment time.

6. **Single-consumer streams.** `ResponseStream` and `BidiSession` throw if
   their async iterator is consumed more than once. This matches JS async
   iterable semantics (a stream can only be read once).

---

## References

- `TYPESCRIPT_SDK_DESIGN.md` §5.1, §5.3, §5.5, §5.8, §7 (Phase 5)
- `STREAMING_RPC_DESIGN.md` §2 (MORE flag), §3 (server-streaming), §4
  (client-streaming), §5 (bidirectional), §6 (cancellation), §10 (wire compat)
- `SIMPLE_API_V2_DESIGN.md` §3 (streaming API design: `ResponseSender`,
  `ResponseStream`, `StreamingHandlerContext`, `HandlerMode`)
- RFC-0002 §4.1 (MORE flag semantics), §4.5 (CLOSE frame)
