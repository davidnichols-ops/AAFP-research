# Builder Prompt: TypeScript SDK Phase 3 — v2 Server-Side API

## Objective

Implement the **server-side** half of the AAFP TypeScript SDK (`@aafp/sdk`),
targeting Simple API v2. This phase delivers everything needed for an agent to
*serve* capabilities: the `ServeBuilder`, per-capability handler dispatch,
`HandlerContext` with `AbortSignal`-based cancellation, the `HandlerError`
class with 8 RFC-0005 error categories, the v2 `Request`/`Response`/`Params`
classes, request/response metadata, the server-side handshake driver, the
session state machine, and a Prometheus-format metrics endpoint.

The client-side half (discovery, connection pooling, streaming consumption) is
a separate phase. This prompt covers **server only**.

---

## Reference Materials

- **`TYPESCRIPT_SDK_DESIGN.md`** §5.1–5.3 — v2 type definitions, `ServeBuilder`,
  `ServingAgent`, `HandlerContext`, `HandlerError`, `StreamingHandlerContext`.
- **`SIMPLE_API_V2_DESIGN.md`** §2 (Capability Forwarding), §6 (Multi-Handler
  Routing), §7 (Handler Cancellation), §8 (Typed Errors) — server-side design.
- **`implementations/rust/crates/aafp-sdk/src/simple.rs`** — the Rust reference
  implementation. The TS code must mirror its behavior: `ServeBuilder`,
  `capability_handlers: HashMap<String, CapabilityHandler>`,
  `streaming_handlers`, `fallback_handler`, the request-handling loop, the
  cancellation race, and the Prometheus exporter.
- **`implementations/rust/crates/aafp-core/src/handshake_state.rs`** — the
  normative handshake state machine (RFC-0002 §5.10). The TS `SessionStateMachine`
  must mirror the server-side states: `Listening → TransportReady → ChVerified →
  ShSent → CfVerified → Authorized → Messaging → Closing → Closed`.
- **`implementations/rust/crates/aafp-sdk/src/metrics.rs`** — `AgentMetrics`
  with lock-free atomic counters. The TS version uses plain number fields
  (JS is single-threaded per event loop).
- **`implementations/rust/crates/aafp-sdk/src/prometheus.rs`** — the Prometheus
  text-format exporter. The TS version serves `GET /metrics` over HTTP.
- **`implementations/rust/crates/aafp-core/src/error.rs`** — RFC-0005 error
  codes. The 8 categories and their default codes:
  - Transport (1xxx) → default 1001 `CONNECTION_RESET`
  - Authentication (2xxx) → default 2001 `INVALID_SIGNATURE`
  - Authorization (3xxx) → default 3001 `UNAUTHORIZED`
  - Discovery (4xxx) → default 4005 `CAPABILITY_NOT_FOUND`
  - Messaging (5xxx) → default 5004 `METHOD_PARAMS_INVALID`
  - Capability (6xxx) → default 6003 `UNSUPPORTED_CAPABILITY`
  - Protocol (8xxx) → default 8009 `PROTOCOL_VIOLATION`
  - Application (9xxx) → default 9000

---

## Files to Create

```
src/
  types.ts              — Params, Request, Response, metadata, HandlerContext,
                         HandlerError, StreamingHandlerContext, handler signatures
  serve.ts              — ServeBuilder, ServingAgent, ServeOptions
  server.ts             — AafpServer (connection accept loop, handler dispatch,
                         cancellation race, streaming forwarder)
  handshake.ts          — HandshakeDriver (server side), handshake state machine
  session.ts            — SessionStateMachine (server-side states)
  metrics.ts            — AgentMetrics, MetricsSnapshot, HealthStatus
  prometheus.ts         — PrometheusExporter (HTTP /metrics endpoint)
  framing.ts            — Frame encode/decode (RFC-0002 §3) — already may exist
                         from Phase 1; ensure server uses it
  rpc.ts                — RpcRequest/RpcResponse encode/decode — same as above
  cbor.ts               — CBOR encode/decode — same as above
```

If `framing.ts`, `rpc.ts`, or `cbor.ts` already exist from an earlier phase,
**do not recreate them** — import and use them. This prompt focuses on the
server-specific files.

---

## 1. v2 Type Definitions (`src/types.ts`)

### 1.1 Params (CBOR IntMap with integer keys)

Mirror `aafp_sdk::simple::Params` from the Rust reference. This is a structured
parameter container backed by a `Map<number, CborValue>`. It supports string,
bytes, u64, and boolean fields with integer keys.

```typescript
export type CborValue =
  | { type: "unsigned"; value: number }
  | { type: "negative"; value: number }
  | { type: "text"; value: string }
  | { type: "bytes"; value: Uint8Array }
  | { type: "array"; items: CborValue[] }
  | { type: "int-map"; entries: [number, CborValue][] }
  | { type: "text-map"; entries: [string, CborValue][] }
  | { type: "null" }
  | { type: "bool"; value: boolean };

export class Params {
  private readonly entries: Map<number, CborValue> = new Map();

  private constructor() {}

  static create(): Params {
    return new Params();
  }

  putStr(key: number, value: string): this {
    this.entries.set(key, { type: "text", value });
    return this;
  }

  putBytes(key: number, value: Uint8Array): this {
    this.entries.set(key, { type: "bytes", value });
    return this;
  }

  putU64(key: number, value: number): this {
    this.entries.set(key, { type: "unsigned", value });
    return this;
  }

  putBool(key: number, value: boolean): this {
    this.entries.set(key, { type: "bool", value });
    return this;
  }

  getStr(key: number): string | undefined {
    const v = this.entries.get(key);
    return v?.type === "text" ? v.value : undefined;
  }

  getBytes(key: number): Uint8Array | undefined {
    const v = this.entries.get(key);
    return v?.type === "bytes" ? v.value : undefined;
  }

  getU64(key: number): number | undefined {
    const v = this.entries.get(key);
    return v?.type === "unsigned" ? v.value : undefined;
  }

  getBool(key: number): boolean | undefined {
    const v = this.entries.get(key);
    return v?.type === "bool" ? v.value : undefined;
  }

  get isEmpty(): boolean {
    return this.entries.size === 0;
  }

  get length(): number {
    return this.entries.size;
  }

  toCbor(): CborValue {
    return {
      type: "int-map",
      entries: [...this.entries.entries()].sort((a, b) => a[0] - b[0]),
    };
  }

  static fromCbor(val: CborValue): Params {
    const params = new Params();
    if (val.type === "int-map") {
      for (const [k, v] of val.entries) {
        params.entries.set(k, v);
      }
    }
    return params;
  }
}
```

### 1.2 RequestMetadata / ResponseMetadata

```typescript
export interface RequestMetadata {
  capability: string;
  sessionId?: Uint8Array;
  traceId?: string;
  deadline?: string;
  contentType?: string;
}

export interface ResponseMetadata {
  contentType?: string;
  extra: Record<string, string>;
}

function defaultRequestMetadata(): RequestMetadata {
  return { capability: "" };
}

function defaultResponseMetadata(): ResponseMetadata {
  return { extra: {} };
}
```

### 1.3 Request (v2)

Carries structured `params`, optional text body, optional binary payload, and
request metadata. Backward compatible with v1 via static `text()` / `data()`.

```typescript
export class Request {
  readonly params: Params;
  readonly text: string;
  readonly data: Uint8Array | null;
  readonly metadata: RequestMetadata;

  private constructor(
    params: Params,
    text: string,
    data: Uint8Array | null,
    metadata: RequestMetadata,
  ) {
    this.params = params;
    this.text = text;
    this.data = data;
    this.metadata = metadata;
  }

  static withParams(params: Params): Request {
    return new Request(params, "", null, defaultRequestMetadata());
  }

  static text(body: string): Request {
    return new Request(Params.create(), body, null, defaultRequestMetadata());
  }

  static data(payload: Uint8Array): Request {
    return new Request(Params.create(), "", payload, defaultRequestMetadata());
  }

  get body(): string {
    return this.text;
  }

  get payload(): Uint8Array | null {
    return this.data;
  }

  withMetadata(fn: (m: RequestMetadata) => void): Request {
    const metadata = { ...this.metadata };
    fn(metadata);
    return new Request(this.params, this.text, this.data, metadata);
  }
}
```

### 1.4 Response (v2)

Same structure as Request but with `result: Params` instead of `params`.

```typescript
export class Response {
  readonly result: Params;
  readonly text: string;
  readonly data: Uint8Array | null;
  readonly metadata: ResponseMetadata;

  private constructor(
    result: Params,
    text: string,
    data: Uint8Array | null,
    metadata: ResponseMetadata,
  ) {
    this.result = result;
    this.text = text;
    this.data = data;
    this.metadata = metadata;
  }

  static withResult(result: Params): Response {
    return new Response(result, "", null, defaultResponseMetadata());
  }

  static text(body: string): Response {
    return new Response(Params.create(), body, null, defaultResponseMetadata());
  }

  static data(payload: Uint8Array): Response {
    return new Response(Params.create(), "", payload, defaultResponseMetadata());
  }

  get body(): string {
    return this.text;
  }

  get payload(): Uint8Array | null {
    return this.data;
  }

  withMetadata(fn: (m: ResponseMetadata) => void): Response {
    const metadata = { ...this.metadata, extra: { ...this.metadata.extra } };
    fn(metadata);
    return new Response(this.result, this.text, this.data, metadata);
  }
}
```

### 1.5 HandlerContext (AbortSignal — TS equivalent of CancellationToken)

The Rust API uses `tokio_util::sync::CancellationToken`. The TS equivalent is
`AbortSignal` — the web-standard primitive. The signal fires when the client
disconnects or the caller aborts the request.

```typescript
export class HandlerContext {
  readonly signal: AbortSignal;
  readonly capability: string;

  constructor(signal: AbortSignal, capability: string) {
    this.signal = signal;
    this.capability = capability;
  }

  get cancelled(): boolean {
    return this.signal.aborted;
  }

  throwIfCancelled(): void {
    if (this.signal.aborted) {
      throw new HandlerError(HandlerErrorCategory.Messaging, "cancelled");
    }
  }
}
```

### 1.6 HandlerError (8 RFC-0005 error categories)

Mirror `aafp_sdk::simple::HandlerError` from the Rust reference. Each category
maps to a default RFC-0005 error code. The `fromCode()` static method reverses
the mapping by inspecting the thousands digit.

```typescript
export enum HandlerErrorCategory {
  Transport = "Transport",
  Authentication = "Authentication",
  Authorization = "Authorization",
  Discovery = "Discovery",
  Messaging = "Messaging",
  Capability = "Capability",
  Protocol = "Protocol",
  Application = "Application",
}

export class HandlerError extends Error {
  readonly category: HandlerErrorCategory;
  readonly code: number;

  constructor(category: HandlerErrorCategory, message: string, code?: number) {
    super(message);
    this.name = "HandlerError";
    this.category = category;
    this.code = code ?? defaultCodeForCategory(category);
  }

  static fromCode(code: number, message: string): HandlerError {
    const category = categoryFromCode(code);
    return new HandlerError(category, message, code);
  }
}

function defaultCodeForCategory(cat: HandlerErrorCategory): number {
  switch (cat) {
    case HandlerErrorCategory.Transport:       return 1001; // CONNECTION_RESET
    case HandlerErrorCategory.Authentication:  return 2001; // INVALID_SIGNATURE
    case HandlerErrorCategory.Authorization:   return 3001; // UNAUTHORIZED
    case HandlerErrorCategory.Discovery:       return 4005; // CAPABILITY_NOT_FOUND
    case HandlerErrorCategory.Messaging:       return 5004; // METHOD_PARAMS_INVALID
    case HandlerErrorCategory.Capability:      return 6003; // UNSUPPORTED_CAPABILITY
    case HandlerErrorCategory.Protocol:        return 8009; // PROTOCOL_VIOLATION
    case HandlerErrorCategory.Application:     return 9000;
  }
}

function categoryFromCode(code: number): HandlerErrorCategory {
  const prefix = Math.floor(code / 1000);
  switch (prefix) {
    case 1: return HandlerErrorCategory.Transport;
    case 2: return HandlerErrorCategory.Authentication;
    case 3: return HandlerErrorCategory.Authorization;
    case 4: return HandlerErrorCategory.Discovery;
    case 5: return HandlerErrorCategory.Messaging;
    case 6: return HandlerErrorCategory.Capability;
    case 8: return HandlerErrorCategory.Protocol;
    case 9: return HandlerErrorCategory.Application;
    default: return HandlerErrorCategory.Protocol;
  }
}
```

### 1.7 StreamingHandlerContext

```typescript
export class StreamingHandlerContext {
  readonly signal: AbortSignal;
  readonly capability: string;
  private readonly sender: (resp: Response | HandlerError) => Promise<void>;

  constructor(
    signal: AbortSignal,
    capability: string,
    sender: (resp: Response | HandlerError) => Promise<void>,
  ) {
    this.signal = signal;
    this.capability = capability;
    this.sender = sender;
  }

  async send(resp: Response): Promise<void> {
    await this.sender(resp);
  }

  async error(err: HandlerError): Promise<void> {
    await this.sender(err);
  }

  get cancelled(): boolean {
    return this.signal.aborted;
  }
}
```

### 1.8 Handler function signatures

```typescript
export type CapabilityHandler =
  (req: Request, ctx: HandlerContext) => Promise<Response>;

export type StreamingHandler =
  (req: Request, ctx: StreamingHandlerContext) => Promise<void>;

export type BidirectionalHandler =
  (requests: AsyncIterable<Request>, ctx: StreamingHandlerContext) => Promise<void>;

export type LegacyHandler = (req: Request) => Promise<Response>;
```

---

## 2. ServeBuilder (`src/serve.ts`)

The `ServeBuilder` is a chainable builder that collects capabilities,
per-capability handlers, streaming handlers, bidirectional handlers, a
deprecated v1 fallback handler, bind address, keypair, metrics address, and
transport factory. The `.start()` method assembles everything into an
`AafpServer` and returns a `ServingAgent`.

### 2.1 ServeOptions

```typescript
export interface ServeOptions {
  capabilities: string[];
  capabilityHandlers: Map<string, CapabilityHandler>;
  streamingHandlers: Map<string, StreamingHandler>;
  bidiHandlers: Map<string, BidirectionalHandler>;
  fallbackHandler: LegacyHandler | null;
  bindAddr?: string;
  keypair?: AgentKeypair;
  metricsAddr?: string;
  transport?: TransportFactory;
  poolConfig?: PoolConfig;
}
```

### 2.2 ServeBuilder class

```typescript
export class ServeBuilder {
  private opts: ServeOptions = {
    capabilities: [],
    capabilityHandlers: new Map(),
    streamingHandlers: new Map(),
    bidiHandlers: new Map(),
    fallbackHandler: null,
  };

  /** Add a capability this agent provides. */
  capability(cap: string): this {
    this.opts.capabilities.push(cap);
    return this;
  }

  /**
   * Register a handler for a specific capability (v2).
   * The handler receives Request + HandlerContext with cancellation and
   * capability info. Multiple capabilities can have different handlers.
   */
  onCapability(cap: string, handler: CapabilityHandler): this {
    this.opts.capabilityHandlers.set(cap, handler);
    if (!this.opts.capabilities.includes(cap)) {
      this.opts.capabilities.push(cap);
    }
    return this;
  }

  /**
   * Register a server-streaming handler (v2).
   * The handler receives Request + StreamingHandlerContext with a send()
   * method for streaming multiple response frames to the client.
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
   * The handler receives an AsyncIterable<Request> + StreamingHandlerContext.
   */
  onBidirectional(cap: string, handler: BidirectionalHandler): this {
    this.opts.bidiHandlers.set(cap, handler);
    if (!this.opts.capabilities.includes(cap)) {
      this.opts.capabilities.push(cap);
    }
    return this;
  }

  /**
   * Set a fallback handler for all capabilities (v1 compat mode).
   * @deprecated Use onCapability() for per-capability routing.
   */
  handler(fn: LegacyHandler): this {
    this.opts.fallbackHandler = fn;
    return this;
  }

  /** Set the bind address (default: random port, 0.0.0.0:0). */
  bind(addr: string): this {
    this.opts.bindAddr = addr;
    return this;
  }

  /** Set the agent's keypair (default: auto-generated). */
  withKeypair(kp: AgentKeypair): this {
    this.opts.keypair = kp;
    return this;
  }

  /** Enable Prometheus metrics endpoint. */
  withMetrics(addr: string): this {
    this.opts.metricsAddr = addr;
    return this;
  }

  /** Explicitly choose a transport (default: auto-detect). */
  withTransport(factory: TransportFactory): this {
    this.opts.transport = factory;
    return this;
  }

  /** Configure connection pooling for outgoing calls (v2). */
  withConnectionPool(config: PoolConfig): this {
    this.opts.poolConfig = config;
    return this;
  }

  /** Build and start the agent. Resolves when serving. */
  async start(): Promise<ServingAgent> {
    const keypair = this.opts.keypair ?? await generateKeypair();
    const transport = await (this.opts.transport ?? defaultTransportFactory)
      .create({
        role: "server",
        bindAddr: this.opts.bindAddr,
        keypair,
      });

    const server = new AafpServer({
      transport,
      keypair,
      capabilities: this.opts.capabilities,
      capabilityHandlers: this.opts.capabilityHandlers,
      streamingHandlers: this.opts.streamingHandlers,
      bidiHandlers: this.opts.bidiHandlers,
      fallbackHandler: this.opts.fallbackHandler,
      poolConfig: this.opts.poolConfig,
    });

    const { agentId, addr } = await server.start();

    // Start Prometheus exporter if metricsAddr is set
    if (this.opts.metricsAddr) {
      const exporter = new PrometheusExporter(server.metrics, agentId);
      // Fire and forget — runs in background
      exporter.serve(this.opts.metricsAddr).catch((e) => {
        console.warn(`Prometheus exporter stopped: ${e}`);
      });
    }

    return new ServingAgent({
      server,
      agentId,
      addr,
      keypair,
      capabilities: this.opts.capabilities,
    });
  }
}
```

### 2.3 ServingAgent

```typescript
export class ServingAgent {
  constructor(
    private readonly ctx: {
      server: AafpServer;
      agentId: AgentId;
      addr: Multiaddr;
      keypair: AgentKeypair;
      capabilities: string[];
    },
  ) {}

  get id(): AgentId { return this.ctx.agentId; }
  get addr(): Multiaddr { return this.ctx.addr; }
  get capabilities(): readonly string[] { return this.ctx.capabilities; }
  get record(): AgentRecord { return this.ctx.server.record; }

  async stop(): Promise<void> {
    await this.ctx.server.stop();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.stop();
  }
}
```

---

## 3. AafpServer (`src/server.ts`) — Connection Accept Loop + Handler Dispatch

This is the core server. It mirrors the Rust `simple.rs` request-handling loop
(lines 630–855). The flow:

1. Accept incoming connections via `transport.accept()`.
2. For each connection, run the server-side handshake (`HandshakeDriver`).
3. After handshake, enter a loop accepting bidirectional streams.
4. For each stream, read the frame header + body, decode the RPC request.
5. Extract the capability name from `rpc_req.method` (v2: method = capability).
6. Convert the RPC params to a `Request` (TextString → `Request.text`,
   ByteString → `Request.data`, IntMap → `Request.withParams`).
7. Populate `request.metadata.capability` and `request.metadata.sessionId`.
8. Look up the handler: streaming handler first, then per-capability handler,
   then fallback handler. If none, send an error response with code 6003
   (`UNSUPPORTED_CAPABILITY`).
9. Create an `AbortController` for cancellation. Race the handler against a
   stream-read that detects client disconnect. If the read returns (EOF/error),
   abort the controller.
10. Encode and send the response. For unary, call `send.finish()` after one
    response. For streaming, keep the stream open and forward frames until the
    handler completes or the channel closes.

### 3.1 Per-capability handler dispatch (HashMap equivalent)

The Rust code uses `HashMap<String, CapabilityHandler>`. In TypeScript, this is
`Map<string, CapabilityHandler>`. The dispatch logic:

```typescript
// Look up unary handler: per-capability first, then fallback
const handler = this.capabilityHandlers.get(capability)
  ?? this.fallbackHandler?.adaptToV2()
  ?? null;

if (!handler) {
  // No handler for this capability — send error 6003
  const rpcResp = encodeRpcResponse({
    id: rpcReq.id,
    result: null,
    error: { code: 6003, message: `no handler for capability '${capability}'` },
  });
  await stream.write(encodeFrame({ type: FrameType.Data, streamId: 0n,
    payload: rpcResp, extensions: new Uint8Array(0), version: 1, flags: 0 }));
  await stream.finish();
  return;
}
```

### 3.2 Cancellation race (AbortSignal equivalent of tokio::select!)

The Rust code races the handler future against a `recv.read()` to detect
client disconnect. In TypeScript, we use `AbortController` + `Promise.race`:

```typescript
const abortCtrl = new AbortController();
const ctx = new HandlerContext(abortCtrl.signal, capability);

// Race handler against client disconnect detection
const disconnectPromise = stream.read().then((data) => {
  // If read returns (EOF, error, or unexpected data), client disconnected
  abortCtrl.abort();
  return null; // sentinel
});

const handlerPromise = handler(request, ctx);

const result = await Promise.race([handlerPromise, disconnectPromise]);

if (result === null) {
  // Client disconnected — handler was aborted, don't send response
  return;
}

// Encode and send response
await this.sendResponse(stream, rpcReq.id, result);
```

### 3.3 Streaming handler forwarder

For streaming handlers, spawn the handler with a `StreamingHandlerContext`
whose `send()` writes frames to the stream. Forward responses until the handler
returns or errors:

```typescript
async function handleStreamingRequest(
  handler: StreamingHandler,
  request: Request,
  capability: string,
  rpcId: number,
  abortCtrl: AbortController,
  stream: BidiStream,
): Promise<void> {
  const ctx = new StreamingHandlerContext(
    abortCtrl.signal,
    capability,
    async (resp) => {
      if (resp instanceof HandlerError) {
        const errResp = encodeRpcResponse({
          id: rpcId, result: null,
          error: { code: resp.code, message: resp.message },
        });
        await stream.write(encodeFrame({ /* ... */, payload: errResp }));
        await stream.finish();
      } else {
        const result = responseToCbor(resp);
        const okResp = encodeRpcResponse({ id: rpcId, result, error: null });
        await stream.write(encodeFrame({ /* ... */, payload: okResp }));
        // Don't finish — keep stream open for more frames
      }
    },
  );

  try {
    await handler(request, ctx);
  } catch (e) {
    if (e instanceof HandlerError) {
      await ctx.error(e);
    } else {
      await ctx.error(new HandlerError(
        HandlerErrorCategory.Application, String(e)));
    }
  }
  await stream.finish();
}
```

### 3.4 Response encoding (v2 wire format)

When encoding a `Response` to an RPC result value, follow the Rust priority:
1. If `result` is non-empty → encode as IntMap.
2. Else if `text` is non-empty → encode as TextString.
3. Else if `data` is non-null → encode as ByteString.
4. Else → empty TextString.

```typescript
function responseToCbor(resp: Response): CborValue {
  if (!resp.result.isEmpty) {
    return resp.result.toCbor();
  } else if (resp.text.length > 0) {
    return { type: "text", value: resp.text };
  } else if (resp.data) {
    return { type: "bytes", value: resp.data };
  } else {
    return { type: "text", value: "" };
  }
}
```

### 3.5 v1 fallback handler adaptation

The v1 `handler()` method takes `LegacyHandler = (req: Request) =>
Promise<Response>`. Internally, it must be adapted to the v2 signature by
wrapping it so it ignores the `HandlerContext` and catches thrown strings as
`HandlerError.Application`:

```typescript
function adaptLegacyHandler(fn: LegacyHandler): CapabilityHandler {
  return async (req: Request, _ctx: HandlerContext): Promise<Response> => {
    try {
      return await fn(req);
    } catch (e) {
      if (e instanceof HandlerError) throw e;
      throw new HandlerError(HandlerErrorCategory.Application, String(e));
    }
  };
}
```

---

## 4. Handshake Driver — Server Side (`src/handshake.ts`)

The server-side handshake driver mirrors the Rust
`drive_server_handshake` logic. It is transport-agnostic — it operates on
CBOR messages exchanged over stream 0. The state machine tracks server-side
sub-states per RFC-0002 §5.10.

### 4.1 Server handshake states

```typescript
export type ServerHandshakeState =
  | "Listening"
  | "TransportReady"
  | "ChVerified"
  | "ShSent"
  | "CfVerified"
  | "Authorized"
  | "Messaging"
  | "Closing"
  | "Closed";
```

### 4.2 Valid transitions (server side)

```
Listening      → TransportReady
TransportReady → ChVerified
ChVerified     → ShSent
ShSent         → CfVerified
CfVerified     → Authorized
Authorized     → Messaging
Messaging      → Closing
Closing        → Closed
```

Graceful shutdown: any active state (`TransportReady` through `Messaging`) can
transition to `Closing`. Abort: any non-terminal state can transition to
`Closed`.

### 4.3 Allowed frame types per state

| State | Allowed frame types (bytes) |
|-------|---------------------------|
| Listening | (none) |
| TransportReady | 0x02 (HANDSHAKE), 0x06 (ERROR) |
| ChVerified, ShSent | 0x02 (HANDSHAKE), 0x06 (ERROR) |
| CfVerified, Authorized | 0x06 (ERROR) |
| Messaging | 0x01, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08 |
| Closing | 0x05 (CLOSE) |
| Closed | (none) |

### 4.4 HandshakeDriver class

```typescript
export class HandshakeDriver {
  private state: ServerHandshakeState = "Listening";
  private transcript: Uint8Array[] = [];
  private readonly keypair: AgentKeypair;
  private sessionId: Uint8Array | null = null;

  constructor(keypair: AgentKeypair) {
    this.keypair = keypair;
  }

  get currentState(): ServerHandshakeState {
    return this.state;
  }

  get established(): boolean {
    return this.state === "Messaging";
  }

  get sessionIdentifier(): Uint8Array | null {
    return this.sessionId;
  }

  /** Check if a transition is valid. */
  canTransitionTo(next: ServerHandshakeState): boolean {
    const allowed: Record<ServerHandshakeState, ServerHandshakeState[]> = {
      Listening:      ["TransportReady", "Closed"],
      TransportReady: ["ChVerified", "Closing", "Closed"],
      ChVerified:     ["ShSent", "Closing", "Closed"],
      ShSent:         ["CfVerified", "Closing", "Closed"],
      CfVerified:     ["Authorized", "Closing", "Closed"],
      Authorized:     ["Messaging", "Closing", "Closed"],
      Messaging:      ["Closing", "Closed"],
      Closing:        ["Closed"],
      Closed:         [],
    };
    return allowed[this.state].includes(next);
  }

  /** Enforce a transition. Throws on illegal transition. */
  transitionTo(next: ServerHandshakeState): void {
    if (!this.canTransitionTo(next)) {
      throw new Error(
        `Illegal handshake transition: ${this.state} → ${next}`,
      );
    }
    this.state = next;
  }

  /** Check if a frame type is allowed in the current state. */
  isFrameAllowed(frameType: number): boolean {
    const allowed = this.allowedFrameTypes();
    return allowed.includes(frameType);
  }

  private allowedFrameTypes(): number[] {
    switch (this.state) {
      case "Listening":      return [];
      case "TransportReady": return [0x02, 0x06];
      case "ChVerified":
      case "ShSent":         return [0x02, 0x06];
      case "CfVerified":
      case "Authorized":     return [0x06];
      case "Messaging":      return [0x01, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08];
      case "Closing":        return [0x05];
      case "Closed":         return [];
    }
  }

  /**
   * Drive the server-side handshake to completion over stream 0.
   * Returns the session ID (32 bytes) on success.
   *
   * Flow:
   * 1. TransportReady — wait for ClientHello on stream 0
   * 2. Verify ClientHello signature (ML-DSA-65), extract peer AgentId
   * 3. ChVerified → generate ServerHello, sign over transcript, send
   * 4. ShSent → wait for ClientFinished
   * 5. CfVerified → verify ClientFinished signature
   * 6. Authorized → derive session ID from transcript hash
   * 7. Messaging — handshake complete
   */
  async driveServerHandshake(stream: BidiStream): Promise<Uint8Array> {
    this.transitionTo("TransportReady");

    // Step 1: Read ClientHello
    const chFrame = await this.readHandshakeFrame(stream);
    const chMsg = decodeCbor(chFrame.payload);
    const peerPublicKey = this.extractPublicKey(chMsg);
    const peerSig = this.extractSignature(chMsg);
    const transcriptHash = this.transcriptHash();

    if (!verifySignature(peerSig, transcriptHash, peerPublicKey)) {
      this.transitionTo("Closed");
      throw new HandlerError(HandlerErrorCategory.Authentication,
        "ClientHello signature verification failed");
    }
    this.transcript.push(chFrame.payload);
    this.transitionTo("ChVerified");

    // Step 2: Generate and send ServerHello
    const shPayload = this.buildServerHello();
    const shSig = this.keypair.sign(this.transcriptHash());
    const shFrame = encodeFrame({
      version: 1, type: FrameType.Handshake, flags: 0, streamId: 0n,
      payload: encodeCbor(this.buildHelloMessage(shPayload, shSig)),
      extensions: new Uint8Array(0),
    });
    await stream.write(shFrame);
    this.transcript.push(shFrame);
    this.transitionTo("ShSent");

    // Step 3: Read ClientFinished
    const cfFrame = await this.readHandshakeFrame(stream);
    const cfMsg = decodeCbor(cfFrame.payload);
    const cfSig = this.extractSignature(cfMsg);
    if (!verifySignature(cfSig, this.transcriptHash(), peerPublicKey)) {
      this.transitionTo("Closed");
      throw new HandlerError(HandlerErrorCategory.Authentication,
        "ClientFinished signature verification failed");
    }
    this.transcript.push(cfFrame.payload);
    this.transitionTo("CfVerified");

    // Step 4: Authorization (TestingAuthProvider — accept all for now)
    this.transitionTo("Authorized");

    // Step 5: Derive session ID and enable messaging
    this.sessionId = sha256(this.transcriptHash());
    this.transitionTo("Messaging");

    return this.sessionId;
  }

  private async readHandshakeFrame(stream: BidiStream): Promise<Frame> {
    const header = await stream.read();
    if (!header || header.length < FRAME_HEADER_SIZE) {
      throw new HandlerError(HandlerErrorCategory.Transport,
        "stream closed during handshake");
    }
    const view = new DataView(header.buffer, header.byteOffset);
    const payloadLen = Number(view.getBigUint64(12));
    const extLen = Number(view.getBigUint64(20));
    const body = await stream.read();
    if (!body || body.length < payloadLen + extLen) {
      throw new HandlerError(HandlerErrorCategory.Transport,
        "incomplete handshake frame body");
    }
    const fullFrame = new Uint8Array(header.length + body.length);
    fullFrame.set(header, 0);
    fullFrame.set(body, header.length);
    return decodeFrame(fullFrame);
  }

  private transcriptHash(): Uint8Array {
    const combined = concatBytes(...this.transcript);
    return sha256(combined);
  }

  private extractPublicKey(msg: CborValue): Uint8Array { /* ... */ }
  private extractSignature(msg: CborValue): Uint8Array { /* ... */ }
  private buildServerHello(): Uint8Array { /* ... */ }
  private buildHelloMessage(
    payload: Uint8Array, sig: Uint8Array,
  ): CborValue { /* ... */ }
}
```

---

## 5. Session State Machine (`src/session.ts`)

The `SessionStateMachine` wraps the handshake state machine and tracks the
higher-level session lifecycle. It enforces that all messaging requires a
completed handshake (Session in `MessagingEnabled` state). No unauthenticated
code path exists — mirroring the Rust `Session` enforcement.

```typescript
export type SessionState =
  | "Idle"
  | "Handshaking"
  | "MessagingEnabled"
  | "Closing"
  | "Closed";

export class SessionStateMachine {
  private state: SessionState = "Idle";
  private sessionId: Uint8Array | null = null;
  private readonly createdAt: number = Date.now();

  get currentState(): SessionState {
    return this.state;
  }

  get sessionIdentifier(): Uint8Array | null {
    return this.sessionId;
  }

  get isMessagingEnabled(): boolean {
    return this.state === "MessagingEnabled";
  }

  /** Begin the handshake phase. */
  beginHandshake(): void {
    if (this.state !== "Idle") {
      throw new Error(`Cannot begin handshake from state ${this.state}`);
    }
    this.state = "Handshaking";
  }

  /** Complete the handshake with a derived session ID. */
  completeHandshake(sessionId: Uint8Array): void {
    if (this.state !== "Handshaking") {
      throw new Error(`Cannot complete handshake from state ${this.state}`);
    }
    this.sessionId = sessionId;
    this.state = "MessagingEnabled";
  }

  /** Fail the handshake. */
  failHandshake(): void {
    this.state = "Closed";
  }

  /** Begin graceful close. */
  beginClose(): void {
    if (this.state !== "MessagingEnabled") {
      throw new Error(`Cannot close from state ${this.state}`);
    }
    this.state = "Closing";
  }

  /** Complete the close. */
  completeClose(): void {
    this.state = "Closed";
  }

  /** Assert that messaging is enabled (enforces authentication). */
  assertMessagingEnabled(): void {
    if (!this.isMessagingEnabled) {
      throw new HandlerError(
        HandlerErrorCategory.Protocol,
        `messaging not enabled (state: ${this.state})`,
      );
    }
  }

  get uptimeMs(): number {
    return Date.now() - this.createdAt;
  }
}
```

---

## 6. AgentMetrics (`src/metrics.ts`)

Mirror `aafp_sdk::metrics::AgentMetrics`. The Rust version uses lock-free
`AtomicU64` counters. In TypeScript (single-threaded event loop), plain number
fields suffice. The `snapshot()` method returns a point-in-time copy.

```typescript
export interface MetricsSnapshot {
  connectionsActive: number;
  connectionsTotal: number;
  messagesSent: number;
  messagesReceived: number;
  bytesSent: number;
  bytesReceived: number;
  handshakesCompleted: number;
  handshakesFailed: number;
  dhtRecords: number;
  relayConnections: number;
  messagesFailed: number;
  uptimeSeconds: number;
}

export enum HealthStatus {
  Healthy = "healthy",
  Degraded = "degraded",
  Unhealthy = "unhealthy",
}

export class AgentMetrics {
  connectionsActive = 0;
  connectionsTotal = 0;
  messagesSent = 0;
  messagesReceived = 0;
  bytesSent = 0;
  bytesReceived = 0;
  handshakesCompleted = 0;
  handshakesFailed = 0;
  dhtRecords = 0;
  relayConnections = 0;
  messagesFailed = 0;
  private readonly startTime: number = Date.now();

  recordConnection(): void {
    this.connectionsActive++;
    this.connectionsTotal++;
  }

  recordDisconnect(): void {
    this.connectionsActive = Math.max(0, this.connectionsActive - 1);
  }

  recordSent(bytes: number): void {
    this.messagesSent++;
    this.bytesSent += bytes;
  }

  recordReceived(bytes: number): void {
    this.messagesReceived++;
    this.bytesReceived += bytes;
  }

  recordMessageFailure(): void {
    this.messagesFailed++;
  }

  recordHandshake(): void {
    this.handshakesCompleted++;
  }

  recordHandshakeFailure(): void {
    this.handshakesFailed++;
  }

  recordDhtRecord(): void {
    this.dhtRecords++;
  }

  recordRelayConnection(): void {
    this.relayConnections++;
  }

  recordRelayDisconnect(): void {
    this.relayConnections = Math.max(0, this.relayConnections - 1);
  }

  get uptimeSeconds(): number {
    return Math.floor((Date.now() - this.startTime) / 1000);
  }

  snapshot(): MetricsSnapshot {
    return {
      connectionsActive: this.connectionsActive,
      connectionsTotal: this.connectionsTotal,
      messagesSent: this.messagesSent,
      messagesReceived: this.messagesReceived,
      bytesSent: this.bytesSent,
      bytesReceived: this.bytesReceived,
      handshakesCompleted: this.handshakesCompleted,
      handshakesFailed: this.handshakesFailed,
      dhtRecords: this.dhtRecords,
      relayConnections: this.relayConnections,
      messagesFailed: this.messagesFailed,
      uptimeSeconds: this.uptimeSeconds,
    };
  }

  get health(): HealthStatus {
    const snap = this.snapshot();
    const errorRate = snap.messagesSent + snap.messagesReceived > 0
      ? snap.messagesFailed / (snap.messagesSent + snap.messagesReceived)
      : 0;
    if (snap.connectionsActive === 0 && snap.connectionsTotal > 0) {
      return HealthStatus.Unhealthy;
    }
    if (errorRate > 0.1) {
      return HealthStatus.Degraded;
    }
    return HealthStatus.Healthy;
  }
}
```

---

## 7. Prometheus Exporter (`src/prometheus.ts`)

Mirror `aafp_sdk::prometheus::PrometheusExporter`. Serves `GET /metrics` in
Prometheus text format over HTTP. Uses Node.js `http` module (or a
runtime-agnostic HTTP server). Only handles `GET /metrics`; returns 404 for
anything else.

```typescript
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { AgentMetrics } from "./metrics.js";

export class PrometheusExporter {
  constructor(
    private readonly metrics: AgentMetrics,
    private readonly agentId: string,
  ) {}

  /** Start serving Prometheus metrics on the given HTTP port. */
  async serve(addr: string): Promise<void> {
    const [host, portStr] = addr.split(":");
    const port = parseInt(portStr, 10);
    const server = createServer((req, res) => {
      this.handleRequest(req, res);
    });
    server.listen(port, host);
    // Runs until the process exits or server.close() is called
    return new Promise<void>((resolve) => {
      server.on("close", () => resolve());
    });
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.method === "GET" && req.url === "/metrics") {
      const body = this.render();
      res.writeHead(200, {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
      });
      res.end(body);
    } else {
      res.writeHead(404, { "Content-Length": "0" });
      res.end();
    }
  }

  /** Generate Prometheus-format text for the current metrics. */
  render(): string {
    const snap = this.metrics.snapshot();
    const id = this.agentId;
    const lines: string[] = [];

    const metric = (
      name: string, help: string, type: string, value: number,
    ) => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} ${type}`);
      lines.push(`${name}{agent_id="${id}"} ${value}`);
    };

    metric("aafp_connections_active", "Current active connections",
      "gauge", snap.connectionsActive);
    metric("aafp_connections_total", "Total connections established",
      "counter", snap.connectionsTotal);
    metric("aafp_messages_sent_total", "Total messages sent",
      "counter", snap.messagesSent);
    metric("aafp_messages_received_total", "Total messages received",
      "counter", snap.messagesReceived);
    metric("aafp_bytes_sent_total", "Total bytes sent",
      "counter", snap.bytesSent);
    metric("aafp_bytes_received_total", "Total bytes received",
      "counter", snap.bytesReceived);
    metric("aafp_handshakes_completed_total", "Total handshakes completed",
      "counter", snap.handshakesCompleted);
    metric("aafp_handshakes_failed_total", "Total handshakes failed",
      "counter", snap.handshakesFailed);
    metric("aafp_dht_records", "DHT records stored",
      "gauge", snap.dhtRecords);
    metric("aafp_relay_connections", "Active relay connections",
      "gauge", snap.relayConnections);
    metric("aafp_messages_failed_total", "Total messages that failed",
      "counter", snap.messagesFailed);
    metric("aafp_uptime_seconds", "Agent uptime in seconds",
      "gauge", snap.uptimeSeconds);

    return lines.join("\n") + "\n";
  }
}
```

---

## 8. AafpServer — Full Connection Loop (`src/server.ts`)

The `AafpServer` ties together the transport, handshake driver, session state
machine, handler dispatch, and metrics. This is the TypeScript equivalent of
the Rust `start()` method (simple.rs lines 610–855).

```typescript
export class AafpServer {
  readonly metrics: AgentMetrics = new AgentMetrics();
  private running = true;
  private _record: AgentRecord | null = null;
  private _agentId: AgentId = "";
  private _addr: Multiaddr = "";

  constructor(private readonly opts: {
    transport: Transport;
    keypair: AgentKeypair;
    capabilities: string[];
    capabilityHandlers: Map<string, CapabilityHandler>;
    streamingHandlers: Map<string, StreamingHandler>;
    bidiHandlers: Map<string, BidirectionalHandler>;
    fallbackHandler: LegacyHandler | null;
    poolConfig?: PoolConfig;
  }) {}

  async start(): Promise<{ agentId: AgentId; addr: Multiaddr }> {
    this._addr = this.opts.transport.localAddr;
    this._agentId = this.opts.keypair.agentId();

    // Build agent record for DHT registration
    this._record = {
      agentId: this._agentId,
      endpoints: [this._addr],
      capabilities: this.opts.capabilities,
      publicKey: this.opts.keypair.publicKey,
    };

    // Start the accept loop in the background
    this.acceptLoop().catch((e) => {
      console.error(`Accept loop error: ${e}`);
    });

    return { agentId: this._agentId, addr: this._addr };
  }

  get record(): AgentRecord {
    if (!this._record) throw new Error("server not started");
    return this._record;
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.opts.transport.close();
  }

  private async acceptLoop(): Promise<void> {
    while (this.running) {
      let conn: Connection;
      try {
        conn = await this.opts.transport.accept();
      } catch {
        continue;
      }
      this.metrics.recordConnection();

      // Handle each connection concurrently
      this.handleConnection(conn).catch(() => {
        this.metrics.recordDisconnect();
      });
    }
  }

  private async handleConnection(conn: Connection): Promise<void> {
    // Run server-side handshake on stream 0
    const handshakeStream = await conn.acceptBidiStream();
    const handshakeDriver = new HandshakeDriver(this.opts.keypair);

    let sessionId: Uint8Array;
    try {
      sessionId = await handshakeDriver.driveServerHandshake(handshakeStream);
      this.metrics.recordHandshake();
    } catch (e) {
      this.metrics.recordHandshakeFailure();
      await conn.close();
      return;
    }

    const session = new SessionStateMachine();
    session.beginHandshake();
    session.completeHandshake(sessionId);

    // If no handlers at all, just keep the connection open
    if (this.opts.capabilityHandlers.size === 0 &&
        this.opts.streamingHandlers.size === 0 &&
        this.opts.bidiHandlers.size === 0 &&
        !this.opts.fallbackHandler) {
      return;
    }

    // Accept bi-streams and handle requests
    while (this.running && session.isMessagingEnabled) {
      let stream: BidiStream;
      try {
        stream = await conn.acceptBidiStream();
      } catch {
        break;
      }

      this.handleStream(stream, session).catch(() => {
        this.metrics.recordMessageFailure();
      });
    }
  }

  private async handleStream(
    stream: BidiStream,
    session: SessionStateMachine,
  ): Promise<void> {
    session.assertMessagingEnabled();

    // Read request frame
    const header = await stream.read();
    if (!header || header.length < FRAME_HEADER_SIZE) return;

    const view = new DataView(header.buffer, header.byteOffset);
    const payloadLen = Number(view.getBigUint64(12));
    const extLen = Number(view.getBigUint64(20));
    const bodyLen = payloadLen + extLen;

    let body: Uint8Array | null = new Uint8Array(bodyLen);
    if (bodyLen > 0) {
      body = await stream.read();
      if (!body || body.length < bodyLen) return;
    }

    const fullFrame = new Uint8Array(header.length + (body?.length ?? 0));
    fullFrame.set(header, 0);
    if (body) fullFrame.set(body, header.length);

    const frame = decodeFrame(fullFrame);
    const rpcReq = decodeRpcRequest(frame.payload);

    // Use method as capability name (v2)
    const capability = rpcReq.method;

    // Convert to simple Request
    let request: Request;
    if (rpcReq.params.type === "text") {
      request = Request.text(rpcReq.params.value);
    } else if (rpcReq.params.type === "bytes") {
      request = Request.data(rpcReq.params.value);
    } else if (rpcReq.params.type === "int-map") {
      request = Request.withParams(Params.fromCbor(rpcReq.params));
    } else {
      request = Request.text("");
    }

    // Populate metadata (v2)
    request = request.withMetadata((m) => {
      m.capability = capability;
      m.sessionId = session.sessionIdentifier ?? undefined;
    });

    this.metrics.recordReceived(fullFrame.length);

    // Create AbortController for cancellation
    const abortCtrl = new AbortController();

    // Check for streaming handler first
    const streamingHandler = this.opts.streamingHandlers.get(capability);
    if (streamingHandler) {
      await handleStreamingRequest(
        streamingHandler, request, capability, rpcReq.id,
        abortCtrl, stream,
      );
      this.metrics.recordSent(1);
      return;
    }

    // Check for bidirectional handler
    const bidiHandler = this.opts.bidiHandlers.get(capability);
    if (bidiHandler) {
      await handleBidiRequest(
        bidiHandler, stream, capability, rpcReq.id,
        abortCtrl, session,
      );
      return;
    }

    // Look up unary handler: per-capability first, then fallback
    let handler = this.opts.capabilityHandlers.get(capability) ?? null;
    if (!handler && this.opts.fallbackHandler) {
      handler = adaptLegacyHandler(this.opts.fallbackHandler);
    }

    if (!handler) {
      // No handler for this capability — send error 6003
      const errResp = encodeRpcResponse({
        id: rpcReq.id, result: null,
        error: { code: 6003, message: `no handler for capability '${capability}'` },
      });
      const errFrame = encodeFrame({
        version: 1, type: FrameType.Data, flags: 0, streamId: 0n,
        payload: errResp, extensions: new Uint8Array(0),
      });
      await stream.write(errFrame);
      await stream.finish();
      return;
    }

    // Create handler context
    const ctx = new HandlerContext(abortCtrl.signal, capability);

    // Race handler against client disconnect detection
    const disconnectPromise = stream.read().then(() => {
      abortCtrl.abort();
      return null;
    });

    let result: Response | null;
    try {
      result = await Promise.race([
        handler(request, ctx),
        disconnectPromise,
      ]);
    } catch (e) {
      // Handler threw — encode error response
      const herr = e instanceof HandlerError
        ? e
        : new HandlerError(HandlerErrorCategory.Application, String(e));
      const errResp = encodeRpcResponse({
        id: rpcReq.id, result: null,
        error: { code: herr.code, message: herr.message },
      });
      const errFrame = encodeFrame({
        version: 1, type: FrameType.Data, flags: 0, streamId: 0n,
        payload: errResp, extensions: new Uint8Array(0),
      });
      await stream.write(errFrame);
      await stream.finish();
      this.metrics.recordMessageFailure();
      return;
    }

    if (result === null) {
      // Client disconnected — handler was aborted
      return;
    }

    // Encode and send success response
    const cborResult = responseToCbor(result);
    const okResp = encodeRpcResponse({
      id: rpcReq.id, result: cborResult, error: null,
    });
    const okFrame = encodeFrame({
      version: 1, type: FrameType.Data, flags: 0, streamId: 0n,
      payload: okResp, extensions: new Uint8Array(0),
    });
    await stream.write(okFrame);
    await stream.finish();
    this.metrics.recordSent(okFrame.length);
  }
}
```

---

## 9. Usage Example (Server Only)

```typescript
import { Agent, Request, Response, Params, HandlerError, HandlerErrorCategory }
  from "@aafp/sdk";

async function main() {
  const server = await Agent.serve()
    .capability("echo")
    .onCapability("echo", async (req, ctx) => {
      // ctx.capability === "echo"
      // ctx.signal is an AbortSignal — fires on client disconnect
      return Response.text(req.body);
    })
    .capability("sum")
    .onCapability("sum", async (req, ctx) => {
      const a = req.params.getU64(1);
      const b = req.params.getU64(2);
      if (a === undefined || b === undefined) {
        throw new HandlerError(
          HandlerErrorCategory.Messaging,
          "missing params: expected keys 1 and 2",
        );
      }
      return Response.withResult(Params.create().putU64(1, a + b));
    })
    .capability("token_stream")
    .onStreaming("token_stream", async (req, ctx) => {
      for (let i = 0; i < 10; i++) {
        if (ctx.cancelled) return;
        await ctx.send(Response.text(`token_${i}`));
        await sleep(100);
      }
    })
    .withMetrics("0.0.0.0:9090")
    .start();

  console.log(`Serving on ${server.addr} (id: ${server.id})`);
  console.log(`Capabilities: ${server.capabilities.join(", ")}`);
  console.log(`Metrics: http://0.0.0.0:9090/metrics`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch(console.error);
```

---

## 10. v1 Backward Compatibility

The v1 `handler()` method is preserved as deprecated. It wraps the legacy
handler as a v2 fallback handler via `adaptLegacyHandler()`. The v1
`Request.text()` / `Response.text()` constructors work identically — the v2
classes are supersets.

```typescript
// v1 code (deprecated but functional)
const server = await Agent.serve()
  .capability("echo")
  .handler(async (req) => Response.text(req.body))  // no ctx, v1 style
  .start();
```

---

## 11. Testing Requirements

- **Unit tests** for `Params` (put/get all types, empty check, CBOR round-trip).
- **Unit tests** for `HandlerError` (all 8 categories, `fromCode` round-trip,
  default codes match RFC-0005).
- **Unit tests** for `SessionStateMachine` (valid/invalid transitions,
  `assertMessagingEnabled` throws when not enabled).
- **Unit tests** for `HandshakeDriver` state transitions (valid/invalid,
  `isFrameAllowed` per state).
- **Unit tests** for `PrometheusExporter.render()` — verify all 12 metrics
  present with correct `# HELP` / `# TYPE` / value lines.
- **Integration test**: start a server with echo + sum capabilities, verify
  `GET /metrics` returns 200 with Prometheus text.
- **Integration test**: verify cancellation — connect a client, start a
  long-running handler, disconnect the client, verify the handler's
  `AbortSignal` fires.
- **Integration test**: verify no-handler error — send an RPC for a capability
  with no registered handler, verify error code 6003.

---

## 12. Key Constraints

1. **Wire format is frozen** (RFC-0002 Rev 6). The TS implementation must
   produce byte-identical CBOR and frame encoding to the Rust reference.
2. **All messaging requires a completed handshake.** No unauthenticated code
   path. `SessionStateMachine.assertMessagingEnabled()` must be called before
   any RPC processing.
3. **`AbortSignal` is the cancellation primitive**, not a custom type. This is
   the web-standard equivalent of Rust's `CancellationToken`.
4. **`handler()` is deprecated** but must continue to work. It adapts to the v2
   signature internally.
5. **Per-capability dispatch uses `Map<string, CapabilityHandler>`** — the TS
   equivalent of Rust's `HashMap<String, CapabilityHandler>`.
6. **Metrics are plain number fields** (not atomics) because JS is
   single-threaded per event loop. The `snapshot()` method returns a copy.
7. **Prometheus exporter uses `node:http`** for Node.js. For browser/Deno
   compatibility, abstract behind an interface (future phase).
8. **The 8 HandlerError categories must map to the exact RFC-0005 default
   codes** listed in §1.6 above.
