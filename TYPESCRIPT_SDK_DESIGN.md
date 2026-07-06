# TypeScript SDK Design Document for AAFP

**Status:** Design proposal
**Date:** 2026-07-04
**Author:** Devin (architect), David Nichols (owner)
**Related:** [NORTH_STAR.md](NORTH_STAR.md) §3 Phase 3, [PHASE_3_ARCHITECTURE.md](PHASE_3_ARCHITECTURE.md) §3.1, [INTEROPERABILITY_PLAN.md](INTEROPERABILITY_PLAN.md)

---

## 1. Executive Summary

AAFP requires SDKs in three languages minimum (Rust, Python, TypeScript) per the
NORTH_STAR. The Rust and Python SDKs are complete and verified. TypeScript is the
next critical SDK — it is the language of the web, of Node.js backends, and of
many AI/agent frameworks (LangChain.js, Vercel AI SDK, the MCP TypeScript SDK).

This document analyzes four implementation approaches — WASM binding, native
TypeScript reimplementation, WebSocket/HTTP bridge, and napi-rs native addon —
and recommends a **hybrid strategy**: a pure-TypeScript implementation as the
primary package (`@aafp/sdk`) for maximum reach and zero-friction `npm install`,
with an optional native addon (`@aafp/sdk-native`) layered on top for users who
need maximum performance. The pure-TS path uses `@noble/post-quantum` for
ML-DSA-65 (FIPS 204), Node.js's experimental `node:quic` (Node 25+) or
WebTransport for the transport, and a pluggable transport abstraction so the
same API works in browsers, Deno, and Bun.

The API surface targets **Simple API v2** — the enhanced design that addresses
all 10 confirmed gaps from the 8 sandbox tests. The v2 API adds structured
`Params` (CBOR IntMap), per-capability handler routing (`on_capability`),
streaming via async iterables, connection pooling with session affinity,
request/response metadata, handler cancellation via `AbortController`, typed
errors (`HandlerError`), and discovery failover. The v1 API is preserved as a
deprecated compatibility layer.

```typescript
// v2: Per-capability handlers with structured params
const agent = await Agent.serve()
  .capability("echo")
  .onCapability("echo", async (req, ctx) => Response.text(req.body))
  .capability("sum")
  .onCapability("sum", async (req, ctx) =>
    Response.withResult(
      Params.create()
        .putU64(1, req.params.getU64(1) + req.params.getU64(2))
    ))
  .start();

// v2: Connection-pooled discovery with failover
const client = await Agent.connect();
const result = await client.discover("echo").call(Request.text("hello"));
console.log(result.body); // "hello"

// v2: Streaming (server-streaming via async iterable)
const stream = await client.discover("token_stream")
  .callStreaming(Request.text("start"));
for await (const chunk of stream) {
  console.log(chunk.body); // "token_0", "token_1", ...
}
```

Estimated effort: **6-8 weeks** for a feature-complete pure-TS v2 (including
streaming, pooling, and typed errors), with the native addon as a follow-on.

---

## 2. Background: The Existing API Surface

### 2.1 Rust simple API (`aafp-sdk/src/simple.rs`)

The Rust SDK exposes three top-level types:

- **`Agent`** — static entry point with `Agent::serve()` and `Agent::connect()`.
- **`Request` / `Response`** — simple value objects with `.text()` / `.data()`
  constructors and `.body()` / `.payload()` accessors.
- **`ServeBuilder`** — chainable builder: `.capability()`, `.handler()`,
  `.bind()`, `.with_keypair()`, `.with_metrics()`, then `.start()`.
- **`ConnectBuilder`** — chainable builder: `.with_keypair()`, `.with_seeds()`,
  then `.connect()`.
- **`ServingAgent`** — running server: `.id()`, `.addr()`, `.record()`, `.stop()`.
- **`ConnectedAgent`** — running client: `.discover(cap)`, `.call_at(addr, req)`,
  `.register(record)`, `.id()`.
- **`DiscoveryBuilder`** — `.call(request)` performs DHT lookup + dial + RPC.

The handler signature is `Fn(Request) -> Future<Output = Result<Response, String>>`.
Internally, the server accepts QUIC connections, runs the v1 handshake
(ML-DSA-65 identity, PQ TLS), then accepts bidirectional streams, decodes the
28-byte frame header + CBOR RPC payload, calls the handler, and encodes the
response. The client dials, handshakes, opens a bidi stream, sends the RPC
frame, and reads the response.

### 2.2 Python simple API (`aafp-py/src/simple.rs`)

The Python adapter wraps the Rust core via PyO3. It mirrors the Rust API with
Python-idiomatic naming: `Request.text("hello")`, `Response.text("world")`,
`Agent.serve(capability="echo")`, `await builder.start()`. The key bridge
mechanism is `pyo3_async_runtimes::tokio::future_into_py`, which converts a
Rust `Future` into a Python awaitable running on a dedicated tokio runtime.
Python async handlers are invoked by acquiring the GIL, calling the Python
callable to get a coroutine, converting the coroutine back to a Rust future via
`into_future_with_locals`, awaiting it (GIL released), then extracting the
`PyResponse`.

### 2.3 What the TypeScript SDK must match — Simple API v2

The TS SDK must provide the identical developer experience: a 3-line agent with
no protocol knowledge required. The async model maps naturally — Rust's tokio
futures and Python's asyncio coroutines both become TypeScript `Promise`s. The
builder pattern maps directly. The main design questions are about the
*transport* and *crypto* layers, not the API shape.

The TS SDK targets **Simple API v2** (see `SIMPLE_API_V2_DESIGN.md`), which
addresses all 10 confirmed gaps from the 8 sandbox tests:

| # | v2 Feature | TS Equivalent |
|---|-----------|---------------|
| 1 | Structured `Params` (CBOR IntMap) | `Params` class with `putStr`/`putU64`/`getStr`/`getU64` |
| 2 | Capability forwarding to handler | `Request.metadata.capability` + `HandlerContext.capability` |
| 3 | Streaming responses | `AsyncIterable<Response>` via `for await` |
| 4 | Session affinity / connection reuse | `ConnectionPool` integrated into `ConnectedAgent` |
| 5 | Request/response metadata | `RequestMetadata` / `ResponseMetadata` interfaces |
| 6 | Per-capability handler routing | `onCapability(cap, handler)` on `ServeBuilder` |
| 7 | Handler cancellation | `AbortSignal` / `AbortController` in `HandlerContext` |
| 8 | Typed error codes | `HandlerError` enum with RFC-0005 categories |
| 9 | Discovery failover + `discover_by_id` | Loop all candidates; `discoverById(agentId)` |
| 10 | Backward compatibility | v1 `handler()` method preserved as deprecated |

The v1 API (single `handler()`, text-only `Request`/`Response`, no streaming)
is preserved as a deprecated compatibility layer so existing code continues to
work during migration.

---

## 3. Analysis of the Four Approaches

### 3.1 Approach A — WASM binding of the Rust core

Compile the Rust crates (`aafp-cbor`, `aafp-crypto`, `aafp-messaging`,
`aafp-sdk`) to `wasm32-wasi` and expose the simple API via `wasm-bindgen`.

**How it would work:** The Rust `simple.rs` logic compiles to WASM. A thin TS
wrapper calls into the WASM module. Async is bridged via `wasm-bindgen-futures`,
which converts Rust futures to JS promises.

**Pros:**
- Single codebase — protocol conformance is "free" (same Rust code as the
  reference implementation). No risk of TS reimplementation diverging from the
  frozen wire format (RFC-0002 Rev 6).
- Runs in the browser *and* Node.js (in principle).
- Crypto (ML-DSA-65, handshake) is the audited Rust implementation, not a JS
  port.

**Cons:**
- **QUIC is not available in WASM.** WASM has no UDP socket access. The
  `aafp-transport-quic` crate (quinn + rustls) cannot compile to WASM. This is
  the fatal flaw. You would need a transport bridge: the WASM module handles
  framing/handshake/crypto, but the actual byte transport must be provided by
  the host (WebTransport in browsers, `node:quic` or a socket in Node). This
  means splitting the crate graph at the transport boundary and defining a
  WASM-import interface for "send bytes / receive bytes on stream N" —
  significant refactoring of the Rust core.
- WASM binary size: the crypto + CBOR + messaging stack is non-trivial
  (hundreds of KB). For browsers this matters.
- No `tokio` in WASM (no multithreading, no I/O driver). The async runtime must
  be single-threaded `wasm-bindgen-futures`, which changes the concurrency model
  from the Rust reference.
- Debugging WASM is harder than debugging native TS.

### 3.2 Approach B — Native TypeScript reimplementation

Implement the AAFP protocol (CBOR framing, v1 handshake, RPC, discovery) in pure
TypeScript, using JS-native libraries for crypto and transport.

**How it would work:**
- **CBOR:** A canonical CBOR encoder/decoder (RFC 8949 deterministic) in TS.
  Either a small custom implementation matching `aafp-cbor`'s integer-keyed map
  semantics, or a vetted library constrained to deterministic encoding.
- **Crypto:** `@noble/post-quantum` provides `ml_dsa65` (FIPS 204) — the exact
  algorithm AAFP uses for agent identity. X25519MLKEM768 hybrid KEX is also
  available. SHA-256/SHAKE via Web Crypto or `@noble/hashes`.
- **Transport:** Node.js 25+ has experimental `node:quic` (ngtcp2-based). For
  browsers, WebTransport (HTTP/3) is now broadly supported (Chrome 97+, Firefox
  114+, Safari 26.4+). For older runtimes, a WebSocket-to-QUIC relay gateway.
- **Handshake:** Reimplement the v1 handshake state machine (RFC-0002 §5) in TS.
  The state machine is transport-agnostic — it operates on CBOR messages, not
  sockets.

**Pros:**
- **`npm install @aafp/sdk` just works.** No native compilation, no prebuilt
  binaries, no platform-specific packages. This is the #1 adoption criterion
  for the JS ecosystem.
- Runs everywhere: Node.js, Deno, Bun, browsers (via WebTransport). One
  codebase, one API.
- Native TS async (Promises, async/await, AbortController) — no FFI bridge, no
  GIL/runtime bridging complexity like PyO3.
- Tree-shakeable: users who only need the client don't pull in server code.
- Full control over the implementation; can optimize for JS idioms (e.g.,
  streaming via async iterables, which are first-class in TS).

**Cons:**
- **Must maintain protocol conformance independently.** The wire format is
  frozen (Rev 6), so this is a one-time implementation cost, not ongoing
  divergence risk. But it requires a conformance test suite (golden traces from
  the Rust implementation) to verify byte-for-byte compatibility.
- **PQ crypto in JS is slower** than native. ML-DSA-65 sign/verify in
  `@noble/post-quantum` is pure JS — roughly 10-50x slower than the Rust
  implementation (which does ~13K verifies/sec per core). For handshake-heavy
  workloads this matters; for typical agent RPC (one handshake per connection,
  many RPCs) it's acceptable.
- `node:quic` is experimental (Node 25+, behind `--experimental-quic`).
  Production users on Node LTS (22/24) cannot use it yet. Need a fallback
  (WebSocket gateway or napi-rs addon).
- Reimplementing the Kademlia DHT in TS is substantial work. For v1, can defer
  to a simpler discovery (direct address, relay directory) and add DHT later.

### 3.3 Approach C — WebSocket/HTTP bridge to a Rust relay (thin client)

The TS SDK is a thin client that speaks a simple JSON/WebSocket protocol to a
Rust relay process, which performs the real AAFP QUIC handshake and forwarding.

**How it would work:** A Rust relay (`aafp relay`) runs locally or remotely. The
TS SDK connects to it via WebSocket and sends `{"method": "discover", "cap":
"echo"}` / `{"method": "call", "addr": "...", "body": "..."}`. The relay
translates to AAFP QUIC and returns results.

**Pros:**
- Simplest TS implementation — no CBOR, no crypto, no QUIC. Just JSON over
  WebSocket.
- Works in every browser and runtime (WebSocket is universal).
- All protocol logic stays in the audited Rust core.

**Cons:**
- **Adds a relay hop.** Every message goes TS → WebSocket → Rust relay → QUIC →
  agent. This adds latency and a dependency on a running relay process. It
  contradicts AAFP's P2P ethos — the whole point is direct agent-to-agent
  communication.
- The relay becomes a trust boundary and a single point of failure.
- The developer experience is worse: "install a relay, then install the SDK."
  This violates the NORTH_STAR adoption test ("Can a developer use AAFP without
  understanding the protocol?").
- Doesn't expose the full API surface (serving an agent from the browser is
  impossible via a relay — you'd need the relay to accept inbound QUIC on your
  behalf, which is a different architecture).

### 3.4 Approach D — napi-rs (Node.js native addon from Rust)

Use `napi-rs` to compile the Rust core (`aafp-sdk`) into a Node.js native addon,
exposing the simple API directly to JS. This is the Node.js analog of the Python
PyO3 approach.

**How it would work:** `napi-rs` generates TypeScript type definitions and a
native `.node` binary from Rust. The async bridge uses `napi-rs`'s
`tokio`-integration (similar to `pyo3_async_runtimes`). The full Rust stack —
QUIC, crypto, handshake, DHT — runs natively.

**Pros:**
- **Full performance.** Native QUIC (quinn), native ML-DSA-65, native DHT. No
  JS crypto overhead. Identical to the Rust reference in capability.
- Protocol conformance is automatic (same Rust code).
- The async bridge is well-trodden: `napi-rs` has first-class async support
  (`Task`, `AsyncTask`, `Promise`).
- Can be published as `@aafp/sdk-native` with prebuilt binaries for
  linux-x64, linux-arm64, darwin-arm64, win32-x64 via GitHub Actions.

**Cons:**
- **Node.js only.** No browser, no Deno (Deno can load napi addons experimentally
  but it's not first-class), no Bun (Bun supports napi but with caveats). This
  excludes the entire browser-agent use case.
- **Platform-specific binaries.** `npm install` must download the right
  prebuilt `.node` for the user's platform. This is the classic native-addon
  pain point (node-gyp, prebuilds, electron-rebuild). `napi-rs` mitigates this
  with `@napi-rs/cli` and optional dependencies, but it's still more fragile
  than pure JS.
- Larger package size (the binary is several MB).
- Build complexity: contributors need Rust + `napi-rs` toolchain to develop.

### 3.5 Comparison Table

| Criterion | A: WASM | B: Native TS | C: Bridge | D: napi-rs |
|-----------|---------|--------------|-----------|------------|
| `npm install` friction | Medium (WASM blob) | **Low (pure JS)** | Low (pure JS) | High (native binary) |
| Browser support | Partial (no QUIC) | **Yes (WebTransport)** | Yes (WebSocket) | No |
| Node.js support | Yes | Yes (Node 25+ QUIC) | Yes | **Yes (all versions)** |
| Deno / Bun | Yes | **Yes** | Yes | Partial |
| Full QUIC | No (no UDP in WASM) | Yes (Node 25+ / WT) | Via relay | **Yes (native)** |
| PQ crypto perf | Native (Rust) | Slow (pure JS) | N/A (relay does it) | **Native (Rust)** |
| Protocol conformance risk | None (same Rust) | Medium (reimpl) | None (Rust relay) | None (same Rust) |
| Can serve agents | Partial | **Yes** | No (relay only) | **Yes** |
| DHT support | Yes (Rust) | Deferred to v2 | Via relay | **Yes (Rust)** |
| Maintenance burden | Low (shared Rust) | Medium (separate impl) | Low | Low (shared Rust) |
| Bundle size | ~500KB WASM | ~50KB JS + deps | ~10KB JS | ~5MB binary |
| Dev experience | Medium | **Best (pure TS)** | Worst (need relay) | Medium |

---

## 4. Recommendation

### 4.1 Primary: Pure TypeScript (`@aafp/sdk`)

**Recommend Approach B (native TypeScript) as the primary SDK**, with Approach D
(napi-rs) as an optional performance package.

**Rationale:**

1. **The adoption test is paramount.** The NORTH_STAR states: "Can a developer
   use AAFP without understanding the protocol? If NO, simplify before adding
   features." A pure-TS package that `npm install`s with zero native deps is the
   lowest-friction path in the JS ecosystem. LangChain.js, the Vercel AI SDK,
   and the MCP TS SDK are all pure TypeScript — AAFP must match that bar.

2. **The wire protocol is frozen.** RFC-0002 is at Rev 6 (Release Candidate)
   with 3 red-team reviews. The TS reimplementation is a one-time cost against a
   stable target, not an ongoing divergence risk. Golden-trace conformance tests
   (generated from the Rust implementation) verify byte-for-byte compatibility.

3. **The crypto gap is closeable.** `@noble/post-quantum` provides audited,
   FIPS-204-compliant ML-DSA-65 — the exact algorithm AAFP uses. It's slower
   than native, but handshake happens once per connection; the steady-state RPC
   path (CBOR frame + bidi stream) is fast in JS. For handshake-heavy
   workloads, users can swap in `@aafp/sdk-native`.

4. **Browser support is a strategic differentiator.** No other agent protocol
   (MCP, A2A) gives you a browser-native agent that speaks post-quantum QUIC.
   WebTransport (HTTP/3) is now in Chrome, Firefox, and Safari (as of March
   2026). A pure-TS SDK with a WebTransport binding enables browser-based agents
   — a capability the Rust/Python SDKs cannot offer.

5. **The transport can be abstracted.** The AAFP handshake and framing layers
   are transport-agnostic (they operate on byte streams, not sockets). A
   `Transport` interface in TS lets the same SDK run over `node:quic`,
   WebTransport, or a WebSocket gateway, selected at runtime.

### 4.2 Optional: Native addon (`@aafp/sdk-native`)

For users who need maximum performance (high-throughput relays, DHT-heavy
workloads, Node LTS without experimental flags), `@aafp/sdk-native` provides the
same API backed by napi-rs. The two packages share the same TypeScript type
definitions; users swap the import:

```typescript
// Pure TS (default, works everywhere)
import { Agent } from "@aafp/sdk";

// Native (max performance, Node.js only)
import { Agent } from "@aafp/sdk-native";
```

This mirrors the pattern in the JS ecosystem (e.g., `@swc/core` vs `@babel/core`,
`sharp` as a native addon, `argon2` vs `argon2-browser`).

---

## 5. API Surface Design

### 5.1 Core types — v2

The v2 API introduces `Params` (structured CBOR IntMap), `RequestMetadata`,
`ResponseMetadata`, `HandlerContext`, and `HandlerError`. The `Request` and
`Response` classes carry both structured params AND optional text/binary
payloads, matching the Rust v2 design exactly.

```typescript
// src/types.ts

// ─── Params (CBOR IntMap with integer keys) ───────────────────

/**
 * Structured parameters — a CBOR IntMap with integer keys.
 * Mirrors `aafp_sdk::simple::Params` in the Rust v2 API.
 *
 * Wire format: encoded as CBOR IntMap in the RPC `params` field (key 3).
 * If params is empty and text is non-empty, falls back to TextString
 * for backward compatibility with v1.
 */
export class Params {
  private readonly entries: Map<number, CborValue> = new Map();

  private constructor() {}

  /** Create empty params. */
  static create(): Params {
    return new Params();
  }

  /** Add a string field. */
  putStr(key: number, value: string): this {
    this.entries.set(key, { type: "text", value });
    return this;
  }

  /** Add a bytes field. */
  putBytes(key: number, value: Uint8Array): this {
    this.entries.set(key, { type: "bytes", value });
    return this;
  }

  /** Add an unsigned integer field. */
  putU64(key: number, value: number): this {
    this.entries.set(key, { type: "unsigned", value });
    return this;
  }

  /** Add a boolean field. */
  putBool(key: number, value: boolean): this {
    this.entries.set(key, { type: "bool", value });
    return this;
  }

  /** Get a string field. */
  getStr(key: number): string | undefined {
    const v = this.entries.get(key);
    return v?.type === "text" ? v.value : undefined;
  }

  /** Get a bytes field. */
  getBytes(key: number): Uint8Array | undefined {
    const v = this.entries.get(key);
    return v?.type === "bytes" ? v.value : undefined;
  }

  /** Get a u64 field. */
  getU64(key: number): number | undefined {
    const v = this.entries.get(key);
    return v?.type === "unsigned" ? v.value : undefined;
  }

  /** Get a boolean field. */
  getBool(key: number): boolean | undefined {
    const v = this.entries.get(key);
    return v?.type === "bool" ? v.value : undefined;
  }

  /** Whether params is empty (triggers v1 backward-compat encoding). */
  get isEmpty(): boolean {
    return this.entries.size === 0;
  }

  /** Convert to CBOR IntMap value for wire encoding. */
  toCbor(): CborValue {
    return {
      type: "int-map",
      entries: [...this.entries.entries()].sort((a, b) => a[0] - b[0]),
    };
  }

  /** Convert from CBOR IntMap value. */
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

// ─── RequestMetadata / ResponseMetadata ───────────────────────

/**
 * Request metadata — populated from RPC extensions or custom headers.
 * Mirrors `aafp_sdk::simple::RequestMetadata` in the Rust v2 API.
 */
export interface RequestMetadata {
  /** The capability name being invoked (forwarded from RPC method). */
  capability: string;
  /** Session ID (32 bytes, from handshake transcript). */
  sessionId?: Uint8Array;
  /** Trace ID for distributed tracing. */
  traceId?: string;
  /** Request deadline (ISO 8601). */
  deadline?: string;
  /** Content type (for binary payloads). */
  contentType?: string;
}

/**
 * Response metadata — additional context returned with a response.
 * Mirrors `aafp_sdk::simple::ResponseMetadata` in the Rust v2 API.
 */
export interface ResponseMetadata {
  /** Content type (for binary payloads). */
  contentType?: string;
  /** Additional metadata fields. */
  extra: Record<string, string>;
}

// ─── Request (v2: params + text + binary + metadata) ──────────

/**
 * A v2 request from a caller to an agent.
 * Carries structured params, optional text body, optional binary payload,
 * and request metadata. Backward compatible with v1 via static text()/data().
 */
export class Request {
  /** Structured parameters (CBOR IntMap). */
  readonly params: Params;
  /** Optional text body (for backward compat / simple cases). */
  readonly text: string;
  /** Optional binary payload. */
  readonly data: Uint8Array | null;
  /** Request metadata. */
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

  /** Create a request with structured params. */
  static withParams(params: Params): Request {
    return new Request(params, "", null, defaultRequestMetadata());
  }

  /** Create a simple text request (v1 backward compat). */
  static text(body: string): Request {
    return new Request(Params.create(), body, null, defaultRequestMetadata());
  }

  /** Create a binary data request. */
  static data(payload: Uint8Array): Request {
    return new Request(Params.create(), "", payload, defaultRequestMetadata());
  }

  /** Get the text body (v1 backward compat). */
  get body(): string {
    return this.text;
  }

  /** Get the binary payload, or null (v1 backward compat). */
  get payload(): Uint8Array | null {
    return this.data;
  }

  /** Set metadata fields via a callback. */
  withMetadata(fn: (m: RequestMetadata) => void): Request {
    const metadata = { ...this.metadata };
    fn(metadata);
    return new Request(this.params, this.text, this.data, metadata);
  }

  toString(): string {
    if (this.data) return `Request.data(${this.data.length} bytes)`;
    if (!this.params.isEmpty) return `Request.withParams(...)`;
    return `Request.text(${JSON.stringify(this.text)})`;
  }
}

function defaultRequestMetadata(): RequestMetadata {
  return { capability: "" };
}

// ─── Response (v2: result + text + binary + metadata) ─────────

/**
 * A v2 response from an agent to a caller.
 * Carries structured result, optional text body, optional binary payload,
 * and response metadata. Backward compatible with v1 via static text()/data().
 */
export class Response {
  /** Structured result (CBOR IntMap). */
  readonly result: Params;
  /** Optional text body (for backward compat). */
  readonly text: string;
  /** Optional binary payload. */
  readonly data: Uint8Array | null;
  /** Response metadata. */
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

  /** Create a response with structured result. */
  static withResult(result: Params): Response {
    return new Response(result, "", null, defaultResponseMetadata());
  }

  /** Create a simple text response (v1 backward compat). */
  static text(body: string): Response {
    return new Response(Params.create(), body, null, defaultResponseMetadata());
  }

  /** Create a binary data response. */
  static data(payload: Uint8Array): Response {
    return new Response(Params.create(), "", payload, defaultResponseMetadata());
  }

  /** Get the text body (v1 backward compat). */
  get body(): string {
    return this.text;
  }

  /** Get the binary payload, or null (v1 backward compat). */
  get payload(): Uint8Array | null {
    return this.data;
  }

  /** Set response metadata. */
  withMetadata(fn: (m: ResponseMetadata) => void): Response {
    const metadata = { ...this.metadata, extra: { ...this.metadata.extra } };
    fn(metadata);
    return new Response(this.result, this.text, this.data, metadata);
  }

  toString(): string {
    if (this.data) return `Response.data(${this.data.length} bytes)`;
    if (!this.result.isEmpty) return `Response.withResult(...)`;
    return `Response.text(${JSON.stringify(this.text)})`;
  }
}

function defaultResponseMetadata(): ResponseMetadata {
  return { extra: {} };
}

// ─── HandlerContext (v2: cancellation + capability) ───────────

/**
 * Handler context — provides cancellation and capability info to handlers.
 * Mirrors `aafp_sdk::simple::HandlerContext` in the Rust v2 API.
 *
 * Cancellation uses `AbortSignal` — the web-standard primitive — instead of
 * Rust's `tokio_util::sync::CancellationToken`. The signal fires when the
 * client disconnects or the caller aborts the request.
 */
export class HandlerContext {
  /** Cancellation signal (fires on client disconnect or caller abort). */
  readonly signal: AbortSignal;
  /** The capability being invoked. */
  readonly capability: string;

  constructor(signal: AbortSignal, capability: string) {
    this.signal = signal;
    this.capability = capability;
  }

  /** Whether the handler has been cancelled. */
  get cancelled(): boolean {
    return this.signal.aborted;
  }

  /** Throw if cancelled. Useful for checkpointing in long handlers. */
  throwIfCancelled(): void {
    if (this.signal.aborted) {
      throw new HandlerError(HandlerErrorCategory.Messaging, "cancelled");
    }
  }
}

// ─── HandlerError (v2: typed errors with RFC-0005 codes) ──────

/**
 * Error categories mirroring RFC-0005 §6 and `aafp_sdk::simple::HandlerError`.
 */
export enum HandlerErrorCategory {
  /** Transport error (1xxx). */
  Transport = "Transport",
  /** Authentication error (2xxx). */
  Authentication = "Authentication",
  /** Authorization error (3xxx). */
  Authorization = "Authorization",
  /** Discovery error (4xxx). */
  Discovery = "Discovery",
  /** Messaging error (5xxx). */
  Messaging = "Messaging",
  /** Capability error (6xxx). */
  Capability = "Capability",
  /** Protocol error (8xxx). */
  Protocol = "Protocol",
  /** Application error (9xxx). */
  Application = "Application",
}

/**
 * Typed error for handler responses. Maps to RFC-0005 error codes on the wire.
 */
export class HandlerError extends Error {
  readonly category: HandlerErrorCategory;
  readonly code: number;

  constructor(category: HandlerErrorCategory, message: string, code?: number) {
    super(message);
    this.name = "HandlerError";
    this.category = category;
    this.code = code ?? defaultCodeForCategory(category);
  }

  /** Create from a wire error code + message. */
  static fromCode(code: number, message: string): HandlerError {
    const category = categoryFromCode(code);
    return new HandlerError(category, message, code);
  }
}

function defaultCodeForCategory(cat: HandlerErrorCategory): number {
  switch (cat) {
    case HandlerErrorCategory.Transport: return 1000;
    case HandlerErrorCategory.Authentication: return 2000;
    case HandlerErrorCategory.Authorization: return 3000;
    case HandlerErrorCategory.Discovery: return 4000;
    case HandlerErrorCategory.Messaging: return 5000;
    case HandlerErrorCategory.Capability: return 6000;
    case HandlerErrorCategory.Protocol: return 8000;
    case HandlerErrorCategory.Application: return 9000;
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

// ─── Handler function signatures ──────────────────────────────

/**
 * v2 unary handler: receives Request + HandlerContext, returns Response.
 * Throws HandlerError on failure.
 */
export type CapabilityHandler =
  (req: Request, ctx: HandlerContext) => Promise<Response>;

/**
 * v2 server-streaming handler: receives Request + StreamingHandlerContext,
 * streams responses via the sender. Throws HandlerError on failure.
 */
export type StreamingHandler =
  (req: Request, ctx: StreamingHandlerContext) => Promise<void>;

/**
 * v2 bidirectional handler: receives an async iterable of Requests +
 * StreamingHandlerContext, streams responses. Throws HandlerError on failure.
 */
export type BidirectionalHandler =
  (requests: AsyncIterable<Request>, ctx: StreamingHandlerContext) => Promise<void>;

/**
 * v1 fallback handler (deprecated — use onCapability instead).
 * Receives Request only, returns Response or throws string error.
 */
export type LegacyHandler = (req: Request) => Promise<Response>;

// ─── Streaming context ────────────────────────────────────────

/**
 * Streaming handler context — provides a response sender for streaming
 * handlers. Mirrors `aafp_sdk::simple::StreamingHandlerContext`.
 */
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

  /** Send a response chunk to the client. */
  async send(resp: Response): Promise<void> {
    await this.sender(resp);
  }

  /** Send an error and close the stream. */
  async error(err: HandlerError): Promise<void> {
    await this.sender(err);
  }

  get cancelled(): boolean {
    return this.signal.aborted;
  }
}

// ─── Other types ──────────────────────────────────────────────

/** Agent ID — a 32-byte ML-DSA-65 public key fingerprint, hex-encoded. */
export type AgentId = string;

/** A multiaddr string, e.g. "/ip4/127.0.0.1/udp/12345/quic-v1". */
export type Multiaddr = string;

/** Error codes mirroring RFC-0005. */
export enum AafpErrorCode {
  HandshakeFailed = 2006,
  FrameTooLarge = 8001,
  UnknownMethod = 5001,
  HandlerError = 5000,
  DiscoveryFailed = 3001,
  NoAgentsFound = 3002,
}

export class AafpError extends Error {
  constructor(
    public readonly code: AafpErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AafpError";
  }
}
```

### 5.2 Top-level Agent entry point

```typescript
// src/agent.ts

/** Top-level entry point for the simple API. */
export class Agent {
  /** Start serving an agent. Returns a ServeBuilder. */
  static serve(): ServeBuilder {
    return new ServeBuilder();
  }

  /** Connect to the AAFP network. Returns a ConnectBuilder. */
  static connect(): ConnectBuilder {
    return new ConnectBuilder();
  }
}
```

### 5.3 ServeBuilder + ServingAgent

```typescript
// src/serve.ts

export interface ServeOptions {
  capabilities: string[];
  handler: Handler | null;
  bindAddr?: string;
  keypair?: AgentKeypair;
  metricsAddr?: string;
  transport?: TransportFactory;
}

export class ServeBuilder {
  private opts: ServeOptions = {
    capabilities: [],
    handler: null,
  };

  /** Add a capability this agent provides. */
  capability(cap: string): this {
    this.opts.capabilities.push(cap);
    return this;
  }

  /** Set the request handler. */
  handler(fn: Handler): this {
    this.opts.handler = fn;
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
      handler: this.opts.handler,
    });

    const { agentId, addr } = await server.start();

    return new ServingAgent({
      server,
      agentId,
      addr,
      keypair,
      capabilities: this.opts.capabilities,
    });
  }
}

/** A running agent that is serving requests. */
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

  /** The agent's ID (hex). */
  get id(): AgentId {
    return this.ctx.agentId;
  }

  /** The agent's multiaddr. */
  get addr(): Multiaddr {
    return this.ctx.addr;
  }

  /** The agent's capabilities. */
  get capabilities(): readonly string[] {
    return this.ctx.capabilities;
  }

  /** The agent's record (for DHT registration). */
  get record(): AgentRecord {
    return this.ctx.server.record;
  }

  /** Stop the serving agent. */
  async stop(): Promise<void> {
    await this.ctx.server.stop();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.stop();
  }
}
```

### 5.4 ConnectBuilder + ConnectedAgent

```typescript
// src/connect.ts

export interface ConnectOptions {
  keypair?: AgentKeypair;
  seeds?: string[];
  transport?: TransportFactory;
}

export class ConnectBuilder {
  private opts: ConnectOptions = {};

  withKeypair(kp: AgentKeypair): this {
    this.opts.keypair = kp;
    return this;
  }

  withSeeds(seeds: string[]): this {
    this.opts.seeds = seeds;
    return this;
  }

  withTransport(factory: TransportFactory): this {
    this.opts.transport = factory;
    return this;
  }

  /** Build the agent and connect to the network. */
  async connect(): Promise<ConnectedAgent> {
    const keypair = this.opts.keypair ?? await generateKeypair();
    const transport = await (this.opts.transport ?? defaultTransportFactory)
      .create({ role: "client", keypair });

    const client = new AafpClient({ transport, keypair, seeds: this.opts.seeds ?? [] });
    await client.bootstrap();
    return new ConnectedAgent({ client, agentId: keypair.agentId() });
  }
}

/** A connected agent that can discover and call other agents. */
export class ConnectedAgent {
  constructor(
    private readonly ctx: {
      client: AafpClient;
      agentId: AgentId;
    },
  ) {}

  get id(): AgentId {
    return this.ctx.agentId;
  }

  /** Discover agents by capability. Returns a DiscoveryBuilder. */
  discover(capability: string): DiscoveryBuilder {
    return new DiscoveryBuilder(this.ctx.client, capability);
  }

  /** Call an agent at a specific address, bypassing discovery. */
  async callAt(addr: Multiaddr, request: Request): Promise<Response> {
    return this.ctx.client.callAt(addr, request);
  }

  /** Register a server's record in the local DHT (for discovery). */
  register(record: AgentRecord): void {
    this.ctx.client.register(record);
  }
}
```

### 5.5 DiscoveryBuilder

```typescript
// src/discovery.ts

export class DiscoveryBuilder {
  constructor(
    private readonly client: AafpClient,
    private readonly capability: string,
  ) {}

  /** Discover an agent with the given capability and call it. */
  async call(request: Request): Promise<Response> {
    const candidates = await this.client.findByCapability(this.capability);
    if (candidates.length === 0) {
      throw new AafpError(
        AafpErrorCode.NoAgentsFound,
        `no agents found for capability '${this.capability}'`,
      );
    }
    const addr = candidates[0].endpoints[0];
    return this.client.callAt(addr, request);
  }
}
```

### 5.6 Complete usage example

```typescript
// examples/echo.ts
import { Agent, Request, Response } from "@aafp/sdk";

async function main() {
  // Serve an echo agent
  const server = await Agent.serve()
    .capability("echo")
    .handler(async (req) => Response.text(req.body))
    .start();

  console.log(`Serving on ${server.addr} (id: ${server.id})`);

  // Connect and call it
  const client = await Agent.connect();
  const result = await client.discover("echo").call(Request.text("hello"));
  console.log(`Response: ${result.body}`); // "hello"

  // Direct call (bypass discovery)
  const direct = await client.callAt(server.addr, Request.text("world"));
  console.log(`Direct: ${direct.body}`); // "world"

  await server.stop();
}

main().catch(console.error);
```

---

## 6. Transport Abstraction

The key architectural decision is a `Transport` interface that decouples the
AAFP handshake/framing/RPC layers from the underlying byte-stream mechanism.
This lets the same SDK run over QUIC (Node 25+), WebTransport (browsers), or a
WebSocket gateway (fallback).

### 6.1 Transport interface

```typescript
// src/transport/interface.ts

/**
 * A bidirectional byte stream — the fundamental unit the AAFP framing layer
 * operates on. Maps to a QUIC bidi stream or a WebTransport bidi stream.
 */
export interface BidiStream {
  /** Write bytes to the stream. */
  write(data: Uint8Array): Promise<void>;
  /** Signal that the send side is finished (half-close). */
  finish(): Promise<void>;
  /** Read the next chunk of bytes, or null if the stream ended. */
  read(): Promise<Uint8Array | null>;
  /** Abort the stream. */
  reset(code?: number): Promise<void>;
}

/**
 * A connection to a peer, providing bidirectional streams.
 * Maps to a QUIC connection or a WebTransport session.
 */
export interface Connection {
  /** Open a new bidirectional stream. */
  openBidiStream(): Promise<BidiStream>;
  /** Accept an incoming bidirectional stream (server side). */
  acceptBidiStream(): Promise<BidiStream>;
  /** Close the connection. */
  close(): Promise<void>;
  /** The peer's address (for logging). */
  readonly remoteAddr: string;
}

/**
 * Factory that creates transport connections (client) or accepts them (server).
 */
export interface Transport {
  /** Dial a peer at the given multiaddr. */
  dial(addr: Multiaddr): Promise<Connection>;
  /** Accept an incoming connection (server side). */
  accept(): Promise<Connection>;
  /** The local address this transport is bound to. */
  readonly localAddr: Multiaddr;
  /** Close the transport. */
  close(): Promise<void>;
}

export interface TransportFactory {
  create(opts: TransportCreateOptions): Promise<Transport>;
}

export interface TransportCreateOptions {
  role: "client" | "server";
  bindAddr?: string;
  keypair: AgentKeypair;
}
```

### 6.2 Concrete transports

```typescript
// src/transport/node-quic.ts — Node.js 25+ native QUIC
import { QuicEndpoint } from "node:quic";

export class NodeQuicTransport implements Transport {
  // Wraps node:quic QuicEndpoint, maps QUIC streams to BidiStream
  // Uses --experimental-quic flag
  // ...
}

// src/transport/webtransport.ts — Browser WebTransport (HTTP/3)
export class WebTransportTransport implements Transport {
  // Wraps the browser WebTransport API
  // WebTransportBidirectionalStream → BidiStream
  // Note: WebTransport is HTTP/3, not raw QUIC, so the ALPN/TLS layer
  // differs. The AAFP handshake still runs on stream 0.
  // ...
}

// src/transport/ws-gateway.ts — WebSocket fallback (via Rust relay)
export class WsGatewayTransport implements Transport {
  // Connects to an AAFP WebSocket gateway (aafp gateway --ws)
  // The gateway translates WebSocket frames ↔ QUIC streams
  // Used when neither node:quic nor WebTransport is available
  // ...
}
```

### 6.3 Auto-detection

```typescript
// src/transport/auto.ts

export const defaultTransportFactory: TransportFactory = {
  async create(opts) {
    // 1. If node:quic is available (Node 25+ with flag), use it
    if (typeof process !== "undefined" && hasNodeQuic()) {
      return new NodeQuicTransport(opts);
    }
    // 2. If WebTransport is available (browser), use it
    if (typeof WebTransport !== "undefined") {
      return new WebTransportTransport(opts);
    }
    // 3. Fallback to WebSocket gateway
    return new WsGatewayTransport(opts);
  },
};

function hasNodeQuic(): boolean {
  try {
    require("node:quic");
    return true;
  } catch {
    return false;
  }
}
```

---

## 7. Protocol Layer Implementation

### 7.1 CBOR (canonical, RFC 8949 deterministic)

AAFP uses canonical CBOR with integer keys for RPC structures. The TS
implementation must produce byte-identical output to `aafp-cbor`.

```typescript
// src/cbor.ts

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

/** Encode a CborValue to deterministic CBOR bytes (RFC 8949 §4.2.2). */
export function encodeCbor(val: CborValue): Uint8Array { /* ... */ }

/** Decode CBOR bytes to a CborValue. */
export function decodeCbor(bytes: Uint8Array): CborValue { /* ... */ }

// Helpers matching aafp_cbor::int_map / int_map_get
export function intMap(entries: [number, CborValue][]): CborValue {
  return { type: "int-map", entries };
}
export function intMapGet(map: CborValue, key: number): CborValue | undefined {
  if (map.type !== "int-map") return undefined;
  return map.entries.find(([k]) => k === key)?.[1];
}
```

### 7.2 Frame encoding (RFC-0002 §3)

```typescript
// src/framing.ts

export const AAFP_VERSION = 1;
export const MAX_PAYLOAD_SIZE = 1024 * 1024; // 1 MiB
export const MAX_EXTENSION_SIZE = 64 * 1024; // 64 KiB
export const FRAME_HEADER_SIZE = 28;

export enum FrameType {
  Data = 0x01,
  Handshake = 0x02,
  RpcRequest = 0x03,
  RpcResponse = 0x04,
  Close = 0x05,
  Error = 0x06,
  Ping = 0x07,
  Pong = 0x08,
}

export interface Frame {
  version: number;
  type: FrameType;
  flags: number;
  streamId: bigint;
  payload: Uint8Array;
  extensions: Uint8Array;
}

/** Encode a frame to bytes: [28-byte header][extensions][payload]. */
export function encodeFrame(frame: Frame): Uint8Array {
  const buf = new ArrayBuffer(FRAME_HEADER_SIZE + frame.extensions.length + frame.payload.length);
  const view = new DataView(buf);
  view.setUint8(0, frame.version);
  view.setUint8(1, frame.type);
  view.setUint8(2, frame.flags);
  view.setUint8(3, 0); // reserved
  view.setBigUint64(4, frame.streamId);
  view.setBigUint64(12, BigInt(frame.payload.length));
  view.setBigUint64(20, BigInt(frame.extensions.length));
  new Uint8Array(buf).set(frame.extensions, FRAME_HEADER_SIZE);
  new Uint8Array(buf).set(frame.payload, FRAME_HEADER_SIZE + frame.extensions.length);
  return new Uint8Array(buf);
}

/** Decode a frame from a header + body. */
export function decodeFrame(bytes: Uint8Array): Frame {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const version = view.getUint8(0);
  const type = view.getUint8(1) as FrameType;
  const flags = view.getUint8(2);
  const streamId = view.getBigUint64(4);
  const payloadLen = Number(view.getBigUint64(12));
  const extLen = Number(view.getBigUint64(20));
  const extensions = bytes.slice(FRAME_HEADER_SIZE, FRAME_HEADER_SIZE + extLen);
  const payload = bytes.slice(FRAME_HEADER_SIZE + extLen, FRAME_HEADER_SIZE + extLen + payloadLen);
  return { version, type, flags, streamId, payload, extensions };
}
```

### 7.3 RPC (RFC-0002 §4.3-4.4)

```typescript
// src/rpc.ts
import { CborValue, encodeCbor, decodeCbor, intMap, intMapGet } from "./cbor.js";

export interface RpcRequest {
  id: number;
  method: string;
  params: CborValue;
}

export interface RpcResponse {
  id: number;
  result: CborValue | null;
  error: { code: number; message: string; data?: Uint8Array } | null;
}

export function encodeRpcRequest(req: RpcRequest): Uint8Array {
  return encodeCbor(intMap([
    [1, { type: "unsigned", value: req.id }],
    [2, { type: "text", value: req.method }],
    [3, req.params],
  ]));
}

export function decodeRpcRequest(bytes: Uint8Array): RpcRequest {
  const val = decodeCbor(bytes);
  const id = intMapGet(val, 1);
  const method = intMapGet(val, 2);
  const params = intMapGet(val, 3);
  if (!id || !method || !params) throw new AafpError(AafpErrorCode.UnknownMethod, "malformed RPC");
  return {
    id: (id as any).value,
    method: (method as any).value,
    params,
  };
}

export function encodeRpcResponse(resp: RpcResponse): Uint8Array {
  const entries: [number, CborValue][] = [
    [1, { type: "unsigned", value: resp.id }],
    [2, resp.result ?? { type: "null" }],
  ];
  if (resp.error) {
    entries.push([3, intMap([
      [1, { type: "unsigned", value: resp.error.code }],
      [2, { type: "text", value: resp.error.message }],
      [3, resp.error.data ? { type: "bytes", value: resp.error.data } : { type: "null" }],
    ])]);
  } else {
    entries.push([3, { type: "null" }]);
  }
  return encodeCbor(intMap(entries));
}
```

### 7.4 Identity & handshake (RFC-0003, RFC-0002 §5)

```typescript
// src/identity.ts
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { randomBytes } from "@noble/post-quantum/utils.js";

export interface AgentKeypair {
  /** ML-DSA-65 public key (1952 bytes). */
  publicKey: Uint8Array;
  /** ML-DSA-65 secret key (4032 bytes). */
  secretKey: Uint8Array;
  /** Agent ID = hex of SHA-256(publicKey). */
  agentId(): AgentId;
  /** Sign a message with ML-DSA-65. */
  sign(msg: Uint8Array): Uint8Array;
}

export async function generateKeypair(seed?: Uint8Array): Promise<AgentKeypair> {
  const keys = ml_dsa65.keygen(seed ?? randomBytes(32));
  return {
    publicKey: keys.publicKey,
    secretKey: keys.secretKey,
    agentId() {
      return toHex(sha256(keys.publicKey));
    },
    sign(msg: Uint8Array) {
      return ml_dsa65.sign(msg, keys.secretKey);
    },
  };
}

export function verifySignature(
  sig: Uint8Array,
  msg: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  return ml_dsa65.verify(sig, msg, publicKey);
}
```

The v1 handshake state machine (RFC-0002 §5.10) is reimplemented in TS as a
transport-agnostic function that takes/returns CBOR messages. It tracks
sub-states, enforces transitions, timeouts, and duplicate detection — mirroring
`aafp-core::handshake_state`.

```typescript
// src/handshake.ts

export type HandshakeState =
  | "Idle"
  | "ClientHelloSent"
  | "ServerHelloReceived"
  | "ServerHelloSent"
  | "Established"
  | "Failed";

export class HandshakeDriver {
  private state: HandshakeState = "Idle";
  private transcript: Uint8Array[] = [];

  /** Produce the next handshake message to send, given the current state. */
  async nextMessage(role: "client" | "server", input?: Uint8Array): Promise<Uint8Array> {
    // Implements the v1 handshake: ClientHello → ServerHello → ClientFinished
    // Each message is CBOR-encoded with ML-DSA-65 signatures over the transcript.
    // ...
  }

  /** Process an incoming handshake message. */
  async processMessage(msg: Uint8Array): Promise<void { /* ... */ }

  get established(): boolean {
    return this.state === "Established";
  }
}
```

---

## 8. Browser vs Node.js Strategy

### 8.1 The transport split

| Runtime | Transport | Notes |
|---------|-----------|-------|
| Node.js 25+ | `node:quic` (experimental) | Full QUIC, ALPN `aafp/1`, PQ TLS via rustls-equivalent |
| Node.js < 25 | WebSocket gateway or `@aafp/sdk-native` | LTS users need a fallback |
| Browser (Chrome/Firefox/Safari) | WebTransport (HTTP/3) | Available since March 2026 broadly |
| Deno | WebTransport (Deno supports it) | Deno also has `Deno.connect` UDP |
| Bun | WebSocket gateway (Bun lacks QUIC) | Or `@aafp/sdk-native` if Bun napi support matures |

### 8.2 WebTransport considerations

WebTransport is HTTP/3-based, not raw QUIC. Key differences:
- **ALPN:** WebTransport uses `h3` ALPN, not `aafp/1`. The AAFP handshake still
  runs on stream 0 (a WebTransport bidi stream), but the TLS layer is HTTP/3's,
  not AAFP's custom ALPN. This is acceptable — the AAFP handshake provides
  application-layer identity (ML-DSA-65) independent of TLS.
- **PQ TLS:** WebTransport uses the browser's TLS stack, which may not support
  X25519MLKEM768 yet. The AAFP handshake's ML-DSA-65 signatures provide
  post-quantum *identity* even if the TLS KEX is classical. This is a
  documented trade-off: PQ identity + classical transport confidentiality,
  upgradeable when browsers add PQ KEX.
- **Server-side WebTransport:** To accept browser connections, an AAFP server
  needs an HTTP/3 endpoint that speaks WebTransport. The Rust `aafp-transport-quic`
  crate (quinn) can be extended to accept WebTransport, or a thin HTTP/3 gateway
  (`aafp gateway --webtransport`) bridges browser WebTransport → internal QUIC.

### 8.3 API difference: browser agents

In the browser, `Agent.serve()` is possible (WebTransport supports server mode
in principle), but most browsers only implement the client side. So browser
agents are primarily *clients* (discover + call). Serving from the browser
requires a relay or a server-side WebTransport endpoint. The API is identical;
only the transport factory differs:

```typescript
// Browser usage (client only)
const client = await Agent.connect()
  .withTransport(new WebTransportTransportFactory())
  .connect();

const result = await client.discover("echo").call(Request.text("hello"));
```

### 8.4 WebSocket gateway fallback

For environments with no QUIC and no WebTransport (old Node, restricted
networks), the SDK falls back to a WebSocket connection to an `aafp gateway`
process. The gateway is a Rust relay that translates WebSocket frames to AAFP
QUIC streams. This is Approach C (bridge) used as a *fallback*, not the primary
path. The API is identical; only latency and the P2P property differ.

---

## 9. Comparison with Existing TS Agent Frameworks

### 9.1 LangChain.js

LangChain.js connects to tools and agents via HTTP-based APIs (OpenAI,
Anthropic) and "runnables" — composable async functions. It does not define a
network protocol; it's an orchestration framework. AAFP is complementary:
LangChain.js agents can be wrapped as AAFP agents (serving capabilities) and
AAFP discovery can replace hardcoded API endpoints in LangChain.js chains.

**Integration point:** An `AafpToolkit` adapter for LangChain.js that exposes
AAFP-discovered agents as LangChain tools:

```typescript
import { AafpToolkit } from "@aafp/langchain";
import { Agent } from "@aafp/sdk";

const client = await Agent.connect();
const toolkit = new AafpToolkit(client, "translation");
// Now usable in a LangChain agent: toolkit.call({ text: "hello" })
```

### 9.2 Vercel AI SDK

The Vercel AI SDK streams LLM responses via `streamText()`, `generateText()`,
etc. It uses HTTP SSE for streaming. AAFP's streaming RPC (RFC-0002 §4.1 MORE
flag, RFC-0009 pubsub) can serve as a transport for Vercel AI SDK streams —
replacing SSE with QUIC streams for lower latency and P2P connectivity.

**Integration point:** An AAFP transport provider for the Vercel AI SDK that
routes `streamText` calls to AAFP-discovered inference agents:

```typescript
import { aafpProvider } from "@aafp/vercel-ai";
const result = await streamText({
  model: aafpProvider("chat"), // discovers an agent with "chat" capability
  prompt: "Hello",
});
```

### 9.3 MCP TypeScript SDK

The MCP TS SDK (`@modelcontextprotocol/sdk`) defines a `Transport` interface
(see [INTEROPERABILITY_PLAN.md](INTEROPERABILITY_PLAN.md) §2.2):

```typescript
interface Transport {
  start(): Promise<void>;
  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void>;
  close(): Promise<void>;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sessionId?: string;
  setProtocolVersion?: (version: string) => void;
}
```

**This is the highest-value integration.** The AAFP TS SDK can implement this
interface, allowing any MCP TS SDK client or server to run over AAFP's
post-quantum QUIC transport — exactly as `aafp-transport-mcp` does for the Rust
`rmcp` SDK. This is the TypeScript analog of the verified Python MCP interop.

```typescript
// src/mcp-transport.ts
import type { Transport, JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export class AafpMcpTransport implements Transport {
  private conn: Connection;
  private stream: BidiStream;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sessionId?: string;

  constructor(conn: Connection) {
    this.conn = conn;
  }

  async start(): Promise<void> {
    this.stream = await this.conn.openBidiStream();
    // Read frames, decode, deliver JSON-RPC to onmessage
    this.readLoop();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const json = new TextEncoder().encode(JSON.stringify(message));
    const frame = encodeFrame({
      version: 1,
      type: FrameType.Data,
      flags: 0,
      streamId: 4n, // RFC-0002 §7.1
      payload: json,
      extensions: new Uint8Array(0),
    });
    await this.stream.write(frame);
  }

  async close(): Promise<void> {
    await this.stream.finish();
    await this.conn.close();
    this.onclose?.();
  }

  private async readLoop(): Promise<void> {
    while (true) {
      const header = await this.readExact(FRAME_HEADER_SIZE);
      if (!header) break;
      const { payload } = decodeFrame(await this.readFullFrame(header));
      const msg = JSON.parse(new TextDecoder().decode(payload)) as JSONRPCMessage;
      this.onmessage?.(msg);
    }
    this.onclose?.();
  }

  private async readExact(n: number): Promise<Uint8Array | null> { /* ... */ }
  private async readFullFrame(header: Uint8Array): Promise<Uint8Array> { /* ... */ }
}
```

Usage with the MCP TS SDK:

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { AafpMcpTransport } from "@aafp/sdk/mcp";
import { Agent } from "@aafp/sdk";

const aafp = await Agent.connect();
const conn = await aafp.dialMcp("quic://agent.example:443");
const transport = new AafpMcpTransport(conn);
const mcpClient = new Client({ name: "my-client", version: "1.0" }, { capabilities: {} });
await mcpClient.connect(transport);

// Now use standard MCP: tools/list, tools/call, etc.
const tools = await mcpClient.listTools();
```

---

## 10. Async/Await Bridge

Rust uses tokio (multi-threaded async runtime). Python uses asyncio (single-
threaded event loop, bridged via PyO3 + `pyo3_async_runtimes`). TypeScript uses
the native event loop (single-threaded, Promise-based). The mapping is the
cleanest of the three:

| Concept | Rust | Python | TypeScript |
|---------|------|--------|------------|
| Async unit | `Future<T>` | coroutine | `Promise<T>` |
| Await | `.await` | `await` | `await` |
| Spawn task | `tokio::spawn(fut)` | `asyncio.create_task(coro)` | `Promise.resolve()` / `queueMicrotask` (fire-and-forget) |
| Cancellation | `CancellationToken` | `asyncio.CancelledError` | `AbortSignal` / `AbortController` |
| Concurrent | `tokio::join!(a, b)` | `asyncio.gather(a, b)` | `Promise.all([a, b])` |
| Stream | `impl Stream<Item>` | `async for` | `AsyncIterable<T>` / `for await` |

No FFI bridge is needed (unlike PyO3's GIL acquisition / `future_into_py`). The
TS SDK is native async throughout. Cancellation uses `AbortSignal` — the web-
standard primitive — threaded into the transport layer:

```typescript
const ctrl = new AbortController();
const result = await client.discover("echo").call(Request.text("hello"), { signal: ctrl.signal });
// ctrl.abort() cancels the in-flight RPC
```

---

## 11. Deno and Bun Support

### 11.1 Deno

Deno supports WebTransport (via its HTTP/3 server) and has `Deno.connect` for
raw UDP. The pure-TS SDK works in Deno with no changes if it uses Web Crypto
(`crypto.subtle`) and WebTransport. Distribution via JSR (`jsr:@aafp/sdk`).

### 11.2 Bun

Bun does not yet have native QUIC. The SDK falls back to the WebSocket gateway
in Bun. As Bun matures QUIC support, a `BunQuicTransport` can be added. Bun
supports `npm:` imports, so the npm package works as-is.

### 11.3 Universal package

The SDK is written in ESM TypeScript with no Node-specific globals at the top
level. Node-specific APIs (`node:quic`, `node:net`) are dynamically imported
only in the Node transport. Browser APIs (`WebTransport`) are feature-detected.
This makes the package "universal" — one source, three runtimes.

---

## 12. Package Distribution

### 12.1 npm (`@aafp/sdk`)

```
@aafp/sdk                    # Pure TS, universal
@aafp/sdk-native             # napi-rs native addon (Node only, optional)
@aafp/langchain              # LangChain.js adapter
@aafp/vercel-ai              # Vercel AI SDK adapter
@aafp/mcp                    # MCP TS SDK transport (or included in @aafp/sdk)
```

The primary package is pure ESM TypeScript, compiled to JS with type
declarations. `package.json` exports map for subpath imports:

```json
{
  "name": "@aafp/sdk",
  "type": "module",
  "exports": {
    ".": "./dist/index.js",
    "./mcp": "./dist/mcp-transport.js",
    "./langchain": "./dist/langchain.js",
    "./transport/node-quic": "./dist/transport/node-quic.js",
    "./transport/webtransport": "./dist/transport/webtransport.js",
    "./transport/ws-gateway": "./dist/transport/ws-gateway.js"
  },
  "peerDependencies": {
    "@modelcontextprotocol/sdk": ">=1.0.0"
  },
  "peerDependenciesMeta": {
    "@modelcontextprotocol/sdk": { "optional": true }
  }
}
```

### 12.2 JSR (Deno)

Published to JSR as `@aafp/sdk`. Deno users import via
`import { Agent } from "jsr:@aafp/sdk";`.

### 12.3 Native addon (`@aafp/sdk-native`)

Published via `napi-rs`'s CI pipeline with prebuilt binaries:
- `@aafp/sdk-native-darwin-arm64`
- `@aafp/sdk-native-linux-x64-gnu`
- `@aafp/sdk-native-linux-arm64-gnu`
- `@aafp/sdk-native-win32-x64-msvc`

The main package `@aafp/sdk-native` lists these as optional dependencies and
loads the right one at runtime.

### 12.4 Browser (CDN)

The pure-TS package is bundleable with esbuild/webpack/Vite. For direct browser
usage, a pre-bundled ESM build is published to a CDN (esm.sh, jsdelivr):

```html
<script type="module">
  import { Agent, Request } from "https://esm.sh/@aafp/sdk";
  const client = await Agent.connect().connect();
  const result = await client.discover("echo").call(Request.text("hello"));
</script>
```

---

## 13. Conformance Strategy

The pure-TS reimplementation must prove byte-for-byte compatibility with the
Rust reference. Strategy:

1. **Golden traces:** The Rust `aafp-conformance` crate generates golden trace
   files (frame bytes, CBOR encodings, handshake transcripts, RPC sequences).
   The TS SDK includes a conformance test suite that replays these traces and
   asserts byte equality.

2. **Cross-language interop tests:** A CI job runs a Rust agent and a TS agent
   and verifies they can handshake, exchange RPCs, and agree on frame encoding.
   Mirrors the Rust ↔ Python interop tests in `INTEROPERABILITY_PLAN.md` §5.3.

3. **ML-DSA-65 cross-verification:** The `@noble/post-quantum` ML-DSA-65
   implementation is verified against the Rust `aafp-crypto::dsa` test vectors
   (the A-10 cross-language vectors in `test-vectors/mldsa65/`). Same seed →
   same key → same deterministic signature.

4. **MCP conformance:** The `AafpMcpTransport` is tested against the official
   MCP conformance suite (`@modelcontextprotocol/conformance`) once an AAFP
   adapter is available for the conformance runner.

---

## 14. Implementation Roadmap

### Phase 1: Core protocol (Week 1-2)

- [ ] CBOR encoder/decoder (canonical, integer-keyed maps) + golden trace tests
- [ ] Frame encode/decode (28-byte header) + golden trace tests
- [ ] RPC request/response encode/decode
- [ ] ML-DSA-65 keygen/sign/verify via `@noble/post-quantum` + cross-verify
      with Rust test vectors
- [ ] Agent ID derivation (SHA-256 of public key)
- [ ] v1 handshake state machine (transport-agnostic, CBOR in/out)

**Deliverable:** `@aafp/sdk` can encode/decode all wire formats, verified
against Rust golden traces. No transport yet.

### Phase 2: Transport + simple API (Week 2-3)

- [ ] `Transport` / `Connection` / `BidiStream` interfaces
- [ ] `NodeQuicTransport` (Node 25+ `node:quic`)
- [ ] `ServeBuilder` / `ServingAgent` / `ConnectBuilder` / `ConnectedAgent` /
      `DiscoveryBuilder`
- [ ] End-to-end echo test: TS server ↔ TS client over localhost QUIC
- [ ] `WsGatewayTransport` fallback

**Deliverable:** `npm install @aafp/sdk` gives a working echo agent on Node 25+.

### Phase 3: Cross-language interop (Week 3-4)

- [ ] TS client ↔ Rust server interop test (CI)
- [ ] TS server ↔ Rust client interop test (CI)
- [ ] Golden trace conformance suite integrated into CI
- [ ] ML-DSA-65 cross-verification (19 Rust vectors verify in TS, etc.)

**Deliverable:** TS SDK is wire-compatible with the Rust reference, proven in CI.

### Phase 4: MCP integration + browser (Week 4-5)

- [ ] `AafpMcpTransport` implementing the MCP TS SDK `Transport` interface
- [ ] MCP TS client ↔ AAFP server interop test
- [ ] `WebTransportTransport` for browsers
- [ ] Browser echo example (client-only)
- [ ] `aafp gateway --webtransport` server-side bridge (Rust side)

**Deliverable:** Browser agents work; MCP TS SDK runs over AAFP.

### Phase 5: Discovery + ecosystem adapters (Week 5-6)

- [ ] Basic discovery (direct address + relay directory; full Kademlia DHT
      deferred to v2)
- [ ] `@aafp/langchain` adapter (AafpToolkit)
- [ ] `@aafp/vercel-ai` adapter (aafpProvider)
- [ ] Deno + Bun smoke tests
- [ ] Documentation: quickstart, API reference, examples

**Deliverable:** Ecosystem-ready SDK with adapters for the major TS agent
frameworks.

### Phase 6 (optional, follow-on): Native addon

- [ ] `@aafp/sdk-native` via napi-rs, wrapping `aafp-sdk` Rust crate
- [ ] Prebuilt binaries for 4 platforms
- [ ] Same TypeScript type definitions as `@aafp/sdk`
- [ ] Benchmark: native vs pure-TS, document the perf delta

**Deliverable:** Optional performance package for Node.js users.

### Time estimates

| Phase | Effort | Cumulative |
|-------|--------|------------|
| 1: Core protocol | 1.5 weeks | 1.5 |
| 2: Transport + API | 1.5 weeks | 3 |
| 3: Cross-language interop | 1 week | 4 |
| 4: MCP + browser | 1 week | 5 |
| 5: Discovery + adapters | 1 week | 6 |
| 6: Native addon (optional) | 1.5 weeks | 7.5 |

**Total to feature-complete pure-TS v1: ~5-6 weeks.**
**With native addon: ~7 weeks.**

---

## 15. Risk Analysis

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `node:quic` stays experimental / removed | Medium | High | WebSocket gateway fallback; `@aafp/sdk-native` for LTS |
| `@noble/post-quantum` ML-DSA-65 diverges from FIPS 204 | Low | High | Cross-verify with Rust test vectors (A-10) |
| CBOR deterministic encoding mismatch | Medium | High | Golden trace tests; use Rust as source of truth |
| WebTransport PQ TLS not available in browsers | High | Medium | AAFP handshake provides PQ identity; TLS KEX is classical (documented trade-off) |
| DHT reimplementation too costly for v1 | High | Medium | Defer full Kademlia to v2; use relay directory for v1 |
| Browser serving not supported | High | Low | Browser = client only for v1; serving via relay/gateway |
| napi-rs build complexity | Medium | Low | Make it optional; pure-TS is the default |

---

## 16. Decision Summary

| Question | Answer |
|----------|--------|
| Primary approach? | **B: Pure TypeScript** (`@aafp/sdk`) |
| Performance option? | **D: napi-rs** (`@aafp/sdk-native`, optional) |
| Browser strategy? | WebTransport (HTTP/3), client-only for v1 |
| Node.js < 25 strategy? | WebSocket gateway fallback or native addon |
| Crypto library? | `@noble/post-quantum` (ML-DSA-65, FIPS 204) |
| Transport abstraction? | `Transport` / `Connection` / `BidiStream` interfaces |
| MCP integration? | `AafpMcpTransport` implements MCP TS SDK `Transport` interface |
| Deno / Bun? | Supported via universal ESM + WebTransport/WS fallback |
| Distribution? | npm + JSR + CDN (browser) |
| Conformance? | Golden traces from Rust + cross-language CI interop |
| DHT in v1? | Deferred (relay directory for v1, full Kademlia in v2) |
| Effort? | 5-6 weeks to feature-complete pure-TS v1 |

---

## 17. References

- [NORTH_STAR.md](NORTH_STAR.md) §3 Phase 3 — SDK in 3 languages
- [PHASE_3_ARCHITECTURE.md](PHASE_3_ARCHITECTURE.md) §3.1 — TypeScript SDK architecture options
- [INTEROPERABILITY_PLAN.md](INTEROPERABILITY_PLAN.md) — MCP cross-SDK interop plan
- [RFC-0002](RFCs/0002-transport-framing.md) — Transport, framing, wire format (Rev 6)
- [RFC-0003](RFCs/0003-identity-authentication.md) — Identity & authentication (ML-DSA-65)
- [RFC-0007](RFCs/0007-mcp-transport-binding.md) — MCP transport binding
- `aafp-sdk/src/simple.rs` — Rust simple API (reference)
- `aafp-py/src/simple.rs` — Python simple API (PyO3 bridge reference)
- `@noble/post-quantum` — https://github.com/paulmillr/noble-post-quantum (ML-DSA-65)
- MCP TypeScript SDK Transport interface — https://ts.sdk.modelcontextprotocol.io
- Node.js QUIC — https://github.com/nodejs/node/pull/62876 (Node 25+, experimental)
- WebTransport browser support — https://caniuse.com/webtransport (Chrome 97+, Firefox 114+, Safari 26.4+)
