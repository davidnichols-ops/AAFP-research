# AAFP WASM Runtime & Browser Agent

**Author:** Devin (research architect)
**Date:** 2026-07-05
**Status:** Research blueprint — complements `TYPESCRIPT_SDK_DESIGN.md` §8 (Browser vs Node.js Strategy) and `builder-prompts/TS_PHASE_6_BROWSER.md`
**Scope:** How the AAFP Rust core compiles to WebAssembly, how it binds to the browser API surface, and what a browser-resident AAFP agent is actually capable of.

---

## Executive Summary

AAFP's strategic differentiator is a **browser-native agent that speaks a
post-quantum, peer-to-peer protocol** — something neither MCP nor A2A offers.
The browser is the most constrained runtime AAFP targets: no raw UDP, no
`node:quic`, no `Buffer`, no filesystem, and a TLS stack the application cannot
customize. This document explains how AAFP reconciles those constraints with its
design.

There are two complementary paths to a browser agent, and AAFP pursues **both**:

1. **Pure-TypeScript SDK (`@aafp/sdk`)** — the primary, zero-friction path. The
   AAFP protocol (CBOR framing, v1 handshake, RPC) is reimplemented in
   TypeScript, using `@noble/post-quantum` for ML-DSA-65 and WebTransport /
   WebSocket for transport. This is the path shipped in Phase 6. It `npm
   install`s with no native dependencies and tree-shakes to ≤ 60 KB gzipped.

2. **WASM runtime (`@aafp/sdk-wasm`)** — an optional performance package that
   compiles the audited Rust crates (`aafp-cbor`, `aafp-crypto`,
   `aafp-messaging`) to `wasm32-unknown-unknown` and exposes them via
   `wasm-bindgen`. It gives browser agents **native-equivalent ML-DSA-65
   performance** (the pure-JS path is 10–50× slower) and protocol conformance
   "for free" — the same Rust code as the reference implementation. The WASM
   module handles framing, handshake, and crypto; the host (browser) provides
   the byte transport via WebTransport or WebSocket.

The two paths share the same TypeScript API surface (`Agent`, `Request`,
`Response`, `Params`, `ConnectedAgent`). Users swap the import:

```typescript
// Pure TS (default — works everywhere, smallest bundle)
import { Agent } from "@aafp/sdk";

// WASM-accelerated (browser + Node, native-equivalent crypto)
import { Agent } from "@aafp/sdk-wasm";
```

This document covers: the WASM compilation pipeline, `wasm-bindgen` bindings,
WebTransport support and its browser matrix, the WebSocket relay fallback,
WebCrypto / `@noble` / WASM crypto strategies, what a browser agent can actually
*do*, the Service Worker and Web Worker agent patterns, WASM bundle-size
optimization, progressive enhancement from WebSocket to WebTransport, the
security model (sandboxing, CORS, CSP), and a concrete worked example of a
browser-based AI assistant calling cloud agents via AAFP.

---

## Table of Contents

1. [The Browser Constraint Envelope](#1-the-browser-constraint-envelope)
2. [WASM Compilation of the AAFP Rust Core](#2-wasm-compilation-of-the-aafp-rust-core)
3. [wasm-bindgen Bindings for the Browser API](#3-wasm-bindgen-bindings-for-the-browser-api)
4. [WebTransport Support in WASM](#4-webtransport-support-in-wasm)
5. [WebSocket Fallback for WASM Agents](#5-websocket-fallback-for-wasm-agents)
6. [WebCrypto, @noble, and WASM Crypto Strategies](#6-webcrypto-noble-and-wasm-crypto-strategies)
7. [Browser Agent Capabilities](#7-browser-agent-capabilities)
8. [Service Worker Agent](#8-service-worker-agent)
9. [Web Worker Agent](#9-web-worker-agent)
10. [WASM Bundle Size Optimization](#10-wasm-bundle-size-optimization)
11. [Progressive Enhancement: WebSocket → WebTransport](#11-progressive-enhancement-websocket--webtransport)
12. [Security: Sandboxing, CORS, CSP](#12-security-sandboxing-cors-csp)
13. [Concrete Example: Browser AI Assistant](#13-concrete-example-browser-ai-assistant)
14. [Build Instructions](#14-build-instructions)
15. [Roadmap and Open Questions](#15-roadmap-and-open-questions)

---

## 1. The Browser Constraint Envelope

Before discussing solutions, it is essential to enumerate exactly what the
browser does *not* provide, because every architectural decision flows from
these constraints.

| Capability | Node.js 25+ | Browser | Deno | Bun |
|------------|-------------|---------|------|-----|
| Raw UDP socket | `node:quic` / `dgram` | **No** | `Deno.connect` UDP | No |
| QUIC (ALPN `aafp/1`) | `node:quic` (experimental) | **No** | No | No |
| WebTransport (HTTP/3 client) | — | **Yes** (Chrome 97+, Safari 17+, FF exp) | Yes | No |
| WebTransport (server) | — | **No** (client only) | Yes (HTTP/3 server) | No |
| WebSocket | `ws` / native | **Yes** | Yes | Yes |
| `crypto.subtle` (WebCrypto) | Yes (16+) | **Yes** | Yes | Yes |
| ML-DSA-65 in WebCrypto | No | **No** | No | No |
| `Buffer` | Yes | **No** | No | Yes |
| Filesystem | `fs` | **No** (IndexedDB / OPFS) | `Deno.readFile` | `Bun.file` |
| `process` / `require` | Yes | **No** | No | No |
| Threads | `worker_threads` | **Web Workers** | Workers | Workers |
| Background execution | daemon | **Service Worker** | — | — |

The two fatal constraints for a faithful WASM port of the *full* Rust stack are:

1. **No UDP in WASM.** The `aafp-transport-quic` crate (quinn + rustls) cannot
   compile to `wasm32-unknown-unknown`. There is no `std::net::UdpSocket`, no
   I/O driver, no `tokio` runtime. This means the WASM module *cannot* do QUIC.
   It must delegate the byte transport to the host.
2. **No custom TLS.** WebTransport uses the browser's TLS stack with `h3` ALPN.
   The application cannot negotiate `aafp/1` ALPN or force
   `X25519MLKEM768` KEX. Post-quantum *identity* is therefore provided at the
   application layer (ML-DSA-65 signatures in the AAFP handshake), not the
   transport layer. This is a documented, upgradeable trade-off.

Everything else — CBOR encoding, the v1 handshake state machine, RPC framing,
ML-DSA-65 sign/verify, agent-record encoding — is pure computation and compiles
to WASM unchanged. The architectural seam is the **transport boundary**: the
WASM module owns everything above it; the host owns everything below it.

```
┌─────────────────────────────────────────────────────────┐
│                  Application (JS / TS)                   │
├─────────────────────────────────────────────────────────┤
│  @aafp/sdk  (TS API: Agent, Request, Response, Params)   │
├──────────────────────┬──────────────────────────────────┤
│  Pure-TS protocol    │  @aafp/sdk-wasm (WASM core)       │
│  (CBOR, handshake,   │  aafp-cbor + aafp-crypto +        │
│   RPC, identity)     │  aafp-messaging, compiled to WASM │
├──────────────────────┴──────────────────────────────────┤
│            Transport abstraction (BidiStream)            │
├──────────────┬───────────────────┬───────────────────────┤
│  node:quic   │  WebTransport     │  WebSocket gateway     │
│  (Node 25+)  │  (Chrome/Safari)  │  (universal fallback)  │
└──────────────┴───────────────────┴───────────────────────┘
```

---

## 2. WASM Compilation of the AAFP Rust Core

### 2.1 Which crates compile

The AAFP Rust workspace is organized as a layered crate graph. Not all layers
are WASM-compatible. The compilation strategy is to build the **protocol and
crypto layers** to WASM and leave the **transport layer** to the host.

| Crate | WASM-compatible? | Role |
|-------|------------------|------|
| `aafp-cbor` | **Yes** | Deterministic CBOR (RFC 8949) encoder/decoder. Pure computation. |
| `aafp-crypto` | **Yes** | ML-DSA-65 (FIPS 204), SHA-256, SHAKE-256, X25519MLKEM768. Pure computation (uses `getrandom` for keygen). |
| `aafp-messaging` | **Yes** | 28-byte frame header, RPC payload encoding, agent record (CBOR). Pure computation. |
| `aafp-identity` | **Yes** | Agent ID (SHA-256 of public key), keypair management. Pure computation. |
| `aafp-handshake` | **Yes** | v1 handshake state machine (RFC-0002 §5). Operates on byte streams, not sockets. |
| `aafp-transport-quic` | **No** | quinn + rustls. Requires UDP + tokio I/O driver. Excluded. |
| `aafp-transport-mcp` | **No** | rmcp + tokio. Excluded (MCP interop is a host-side concern). |
| `aafp-sdk` (simple API) | **Partial** | The `simple.rs` server/client logic references `aafp-transport-quic`. A WASM shim replaces the transport with a host-provided `BidiStream`. |

The WASM build produces a single module from `aafp-cbor` + `aafp-crypto` +
`aafp-messaging` + `aafp-identity` + `aafp-handshake`, plus a thin slice of
`aafp-sdk` that wires the handshake and RPC layers to a host-injected stream
interface. The `aafp-transport-quic` dependency is feature-gated out.

### 2.2 The target: `wasm32-unknown-unknown`

AAFP targets `wasm32-unknown-unknown` (the freestanding WASM target), **not**
`wasm32-wasi`. The reasons:

- **`wasm32-wasi`** provides a POSIX-like syscall interface (filesystem, clocks,
  randomness) via WASI. It is heavier and requires a WASI runtime (Wasmtime,
  `wasmtime-run`, Node's experimental WASI). Browser `WebAssembly.instantiate`
  does not natively provide WASI — you must polyfill `fd_write`, `random_get`,
  etc.
- **`wasm32-unknown-unknown`** is the minimal target. It has no I/O syscalls at
  all. All host interaction is via imported functions (`wasm-bindgen` imports).
  This is the target `wasm-bindgen` and `wasm-pack` are designed for. It
  produces the smallest binary and the cleanest browser integration.

The one WASI facility AAFP needs is **cryptographic randomness** (for ML-DSA-65
keygen). On `wasm32-unknown-unknown`, this is provided by the `getrandom` crate,
which is configured to call a host-imported function that reads
`crypto.getRandomValues()` in the browser. This is the standard pattern used by
`@noble/post-quantum`'s Rust counterparts and by the `rand` ecosystem.

### 2.3 The transport seam

The key refactoring insight (from `TYPESCRIPT_SDK_DESIGN.md` §3.1) is that the
AAFP handshake and framing layers are **transport-agnostic** — they operate on
byte streams, not sockets. The WASM module defines a host-import interface:

```rust
// wasm-src/host_transport.rs (imported from JS)

#[wasm_bindgen]
extern "C" {
    pub type HostStream;

    #[wasm_bindgen(method, js_name = write)]
    pub fn write(this: &HostStream, data: &[u8]) -> js_sys::Promise;

    #[wasm_bindgen(method, js_name = read)]
    pub fn read(this: &HostStream) -> js_sys::Promise;

    #[wasm_bindgen(method, js_name = finish)]
    pub fn finish(this: &HostStream) -> js_sys::Promise;
}

#[wasm_bindgen]
extern "C" {
    pub type HostConnection;

    #[wasm_bindgen(method, js_name = openBidiStream)]
    pub fn open_bidi_stream(this: &HostConnection) -> js_sys::Promise;
}
```

The JS side implements `HostConnection` / `HostStream` as a thin wrapper over
`WebTransportBidirectionalStream` or a WebSocket-multiplexed logical stream (see
§5). The WASM module calls these imports to send/receive bytes; it never touches
a socket.

This is the same `BidiStream` / `Connection` interface the pure-TS SDK uses
(`src/transport/interface.ts`), just expressed across the WASM FFI boundary.

### 2.4 Async: `wasm-bindgen-futures`, not `tokio`

WASM has no threads (without `wasm32-unknown-unknown` + `--target=wasm32` +
shared memory + `atomics`, which is not broadly supported). There is no `tokio`
I/O driver. The async runtime is `wasm-bindgen-futures`, which converts Rust
`Future`s to JS `Promise`s via a single-threaded event loop driven by the
browser's microtask queue.

This changes the concurrency model from the Rust reference:

- No `tokio::spawn`. All async work is driven by `Promise`s awaited from JS.
- No `tokio::select!`. Use `Future::race` or poll-based combinators.
- No parallelism. The WASM module is single-threaded. For CPU-bound crypto
  (ML-DSA-65 sign/verify), this is fine — the operations are fast enough that
  single-threaded is acceptable, and offloading to a Web Worker (§9) keeps the
  main thread responsive.

The `aafp-handshake` state machine is already `Future`-based and does not depend
on `tokio::spawn`, so it ports cleanly. The `aafp-sdk` simple API's
`ServingAgent` / `ConnectedAgent` types are refactored to drive their event
loops via `wasm-bindgen-futures::spawn_local` instead of `tokio::spawn`.

---

## 3. wasm-bindgen Bindings for the Browser API

### 3.1 The binding layer

`wasm-bindgen` generates TypeScript type definitions and a JS glue module from
Rust `#[wasm_bindgen]` annotations. The AAFP WASM package exposes a surface
that mirrors the pure-TS SDK's `Agent` / `Request` / `Response` / `Params`:

```rust
// wasm-src/lib.rs

use wasm_bindgen::prelude::*;
use aafp_crypto::dsa::ml_dsa65;
use aafp_cbor::Encoder;
use aafp_handshake::HandshakeInitiator;
use aafp_messaging::{Frame, RpcRequest};

#[wasm_bindgen]
pub struct Agent {
    inner: aafp_sdk_wasm::AgentInner,
}

#[wasm_bindgen]
impl Agent {
    #[wasm_bindgen]
    pub async fn connect() -> Result<Agent, JsValue> {
        let inner = aafp_sdk_wasm::AgentInner::connect().await
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(Agent { inner })
    }

    #[wasm_bindgen]
    pub async fn discover(&self, capability: &str) -> Result<DiscoveryBuilder, JsValue> {
        let b = self.inner.discover(capability).await
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(DiscoveryBuilder { inner: b })
    }
}

#[wasm_bindgen]
pub struct Request {
    inner: aafp_sdk_wasm::RequestInner,
}

#[wasm_bindgen]
impl Request {
    #[wasm_bindgen]
    pub fn text(body: &str) -> Request {
        Request { inner: aafp_sdk_wasm::RequestInner::text(body) }
    }

    #[wasm_bindgen]
    pub fn data(body: &[u8]) -> Request {
        Request { inner: aafp_sdk_wasm::RequestInner::data(body) }
    }
}
```

The generated `.d.ts` gives JS consumers a typed API identical to `@aafp/sdk`:

```typescript
// Generated by wasm-bindgen — @aafp/sdk-wasm/aafp_sdk_wasm.d.ts
export class Agent {
  static connect(): Promise<Agent>;
  discover(capability: string): Promise<DiscoveryBuilder>;
}

export class Request {
  static text(body: string): Request;
  static data(body: Uint8Array): Request;
}
```

### 3.2 Memory management across the FFI boundary

WASM and JS share a single `WebAssembly.Memory` linear buffer. Passing large
byte arrays (CBOR frames, ML-DSA-65 signatures, agent records) across the
boundary requires care:

- **Small data (< 1 KB):** `wasm-bindgen`'s default `&[u8]` / `Vec<u8>` handling
  copies bytes through the JS glue. Fine for handshake messages and small RPCs.
- **Large data (≥ 1 KB):** Use `js_sys::Uint8Array` with
  `Uint8Array::view(&wasm_memory()[offset..end])` to expose a zero-copy view of
  the WASM linear memory to JS. The JS side must copy (`slice()`) before the
  WASM side reuses that memory region. This avoids a full copy on every frame.
- **Streaming:** For RPC response bodies, expose a `ReadableStream`-backed
  `Response.body` that pulls chunks from the WASM side on demand, rather than
  buffering the entire response in WASM memory.

The `aafp-messaging` frame decoder is modified to read from a `HostStream`'s
`read()` import incrementally, rather than buffering the whole frame in WASM
memory. This keeps the WASM heap small (important for mobile browsers).

### 3.3 Error propagation

Rust `Result<T, E>` maps to `Result<T, JsValue>` at the FFI. Errors are
stringified and thrown as JS `Error` objects. The `HandlerError` enum (RFC-0005
categories) is serialized as a structured JS object so the TS layer can switch
on error codes:

```rust
#[wasm_bindgen]
pub struct HandlerError {
    #[wasm_bindgen(js_name = code)]
    pub code: u16,
    #[wasm_bindgen(js_name = message)]
    pub message: String,
}
```

---

## 4. WebTransport Support in WASM

### 4.1 Browser support matrix (as of July 2026)

| Browser | WebTransport client | WebTransport server | Notes |
|---------|---------------------|---------------------|-------|
| Chrome / Edge 97+ | **Yes** | No (client only) | Stable since 2022. |
| Safari 17+ | **Yes** | No | Shipped in Safari 17 (Sept 2023); broadly available by Safari 26.4. |
| Firefox | **Experimental** | No | Behind `network.http.http3.enable` + `dom.quic` prefs; shipping in nightly. Expected stable in Firefox 141+ (late 2026). |
| Deno | **Yes** | Yes (HTTP/3 server) | `Deno.serve({ port, alpn })` with `onWebTransport`. |
| Bun | **No** | No | Falls back to WebSocket gateway. |

WebTransport is HTTP/3-based, not raw QUIC. The implications for AAFP:

- **ALPN is `h3`, not `aafp/1`.** The AAFP handshake runs on stream 0 (a
  WebTransport bidi stream) as application-layer logic. The TLS layer is the
  browser's, not AAFP's custom ALPN. This is acceptable — AAFP's identity is
  ML-DSA-65, independent of TLS.
- **No custom TLS certificates.** The browser validates the server's cert
  against its CA store. For local dev, WebTransport accepts
  `serverCertificateHashes` (SHA-256 of the self-signed cert's DER). In
  production, use a real CA (Let's Encrypt, or an internal CA).
- **PQ TLS is the browser's choice.** The browser's TLS stack may not support
  `X25519MLKEM768` yet. AAFP gets PQ *identity* (ML-DSA-65 signatures) even if
  the transport KEX is classical. This is upgradeable: when browsers ship PQ
  KEX, AAFP inherits it automatically (no code change).

### 4.2 The WebTransport adapter (host side)

The WASM module's `HostConnection` import is implemented in JS by wrapping a
`WebTransport` session:

```typescript
// @aafp/sdk-wasm/transport/webtransport.ts

export class WebTransportHostConnection {
  constructor(private session: WebTransport) {}

  async openBidiStream(): Promise<WebTransportHostStream> {
    const stream = await this.session.createBidirectionalStream();
    return new WebTransportHostStream(stream);
  }
}

export class WebTransportHostStream {
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private reader: ReadableStreamDefaultReader<Uint8Array>;

  constructor(stream: WebTransportBidirectionalStream) {
    this.writer = stream.writable.getWriter();
    this.reader = stream.readable.getReader();
  }

  async write(data: Uint8Array): Promise<void> {
    await this.writer.write(data);
  }

  async read(): Promise<Uint8Array | null> {
    const { value, done } = await this.reader.read();
    return done ? null : (value as Uint8Array);
  }

  async finish(): Promise<void> {
    await this.writer.close();
  }
}
```

This is injected into the WASM module at instantiation. The WASM handshake code
calls `hostStream.write(frameBytes)` and `hostStream.read()` exactly as it would
call a QUIC bidi stream in the native Rust build.

### 4.3 Multiaddr → WebTransport URL mapping

AAFP addresses are multiaddrs (`/ip4/1.2.3.4/udp/443/quic-v1/webtransport`). The
adapter converts to a WebTransport URL (`https://1.2.3.4:443/aafp`). The
conversion is deterministic:

```
/ip4/<ip>/udp/<port>/quic-v1/webtransport  →  https://<ip>:<port>/aafp
/dns4/<host>/udp/<port>/quic-v1/webtransport  →  https://<host>:<port>/aafp
```

The `/aafp` path is the WebTransport session URL; the AAFP server's HTTP/3
endpoint accepts WebTransport sessions at that path and bridges them to the
internal QUIC listener.

---

## 5. WebSocket Fallback for WASM Agents

### 5.1 Why a fallback is mandatory

WebTransport is not universal. Firefox is still experimental; corporate
proxies and firewalls often block UDP (and thus HTTP/3); Bun has no QUIC at
all. AAFP's progressive-enhancement principle (§11) requires a path that works
*everywhere WebSocket works* — and WebSocket is universal.

The fallback is the **WebSocket-to-QUIC relay** (`aafp gateway --ws`): a Rust
process that accepts WebSocket connections from browsers and translates each
logical stream to a real QUIC bidi stream on the AAFP network side. From the
WASM module's perspective, the relay is just another `HostConnection` — the
stream multiplexing is invisible to the protocol layer.

### 5.2 The multiplexing protocol

A single WebSocket carries many logical bidi streams. The framing layer (from
`TS_PHASE_6_BROWSER.md` §6.1):

```
Frame layout (binary WebSocket messages):
  [4 bytes: streamId (u32 big-endian)]
  [1 byte:  frame type]
  [4 bytes: payload length (u32 big-endian)]
  [N bytes: payload]

Frame types:
  0x01 OPEN    — client opens a new logical stream
  0x02 DATA    — payload bytes for the stream
  0x03 FIN     — sender half-closed (no payload)
  0x04 RESET   — stream aborted (payload = 1-byte reset code)
  0x05 PING    — keepalive (no payload)
  0x06 PONG    — keepalive response
```

The relay assigns stream IDs (client-initiated: odd; server-initiated: even),
translates each `OPEN` to a `quinn::Connection::open_bi()`, and pumps `DATA`
frames bidirectionally. `FIN` maps to `stream.finish()`; `RESET` maps to
`stream.reset(code)`.

### 5.3 The WebSocket host connection

```typescript
// @aafp/sdk-wasm/transport/ws-gateway.ts

export class WsGatewayHostConnection {
  private nextStreamId = 1;
  private streams = new Map<number, WsGatewayHostStream>();

  constructor(private ws: WebSocket) {
    ws.binaryType = "arraybuffer";
    this.readLoop();
  }

  async openBidiStream(): Promise<WsGatewayHostStream> {
    const id = this.nextStreamId;
    this.nextStreamId += 2;
    const stream = new WsGatewayHostStream(id, this);
    this.streams.set(id, stream);
    this.sendFrame(id, 0x01, new Uint8Array(0)); // OPEN
    return stream;
  }

  // ...sendFrame, readLoop, dispatch by streamId...
}
```

The `WsGatewayHostStream` implements the same `write` / `read` / `finish`
interface as `WebTransportHostStream`, so the WASM module is agnostic to which
transport is active.

### 5.4 The trade-off

The relay adds a hop: browser → WebSocket → relay → QUIC → agent. This adds
~10–50 ms latency (depending on relay placement) and breaks the P2P property
(the relay is a trusted intermediary). It is a **fallback, not the primary
path**. The auto-detection factory (§11) prefers WebTransport whenever
available.

---

## 6. WebCrypto, @noble, and WASM Crypto Strategies

ML-DSA-65 (FIPS 204) is AAFP's post-quantum signature algorithm for agent
identity. It is **not** in the WebCrypto standard (`crypto.subtle` supports
ECDSA, Ed25519, RSA-PSS, but no PQ algorithms as of 2026). There are three
strategies for performing ML-DSA-65 in the browser, in order of performance:

### 6.1 Strategy A: `@noble/post-quantum` (pure JS, default)

The pure-TS SDK's default. `@noble/post-quantum` implements `ml_dsa65` in pure
TypeScript — no native code, no WASM. It works in every runtime (Node, browser,
Deno, Bun) with zero install friction.

- **Performance:** ~10–50× slower than native Rust. ML-DSA-65 verify is ~1–5 ms
  in JS vs ~75 µs in Rust. For a handshake-heavy workload (many short-lived
  connections), this is noticeable. For typical agent RPC (one handshake per
  connection, many RPCs), it is acceptable.
- **Bundle cost:** ~40 KB gzipped for the ML-DSA-65 code.
- **Conformance:** audited, FIPS 204. Verified against the AAFP A-10 test
  vectors (same seed → same key → same deterministic signature).

### 6.2 Strategy B: WASM-compiled `aafp-crypto` (optional, `@aafp/sdk-wasm`)

Compile the Rust `aafp-crypto` crate (which uses `fips204` / `pqcrypto`) to
WASM. This gives **native-equivalent performance** in the browser — the same
audited Rust code, just compiled to WASM.

- **Performance:** ~2–5× slower than native (WASM overhead vs native), vs
  10–50× for pure JS. ML-DSA-65 verify drops to ~150–300 µs.
- **Bundle cost:** ~150–250 KB gzipped for the WASM module (ML-DSA-65 tables +
  SHAKE-256 + the rest of the crypto stack). Larger than pure JS, but loaded
  once and cached.
- **Conformance:** identical to the Rust reference (same code).
- **Instantiation:** `WebAssembly.instantiate(wasmBytes, imports)` where
  `imports.env.__getrandom` reads `crypto.getRandomValues()`.

### 6.3 Strategy C: WebCrypto for non-ML-DSA operations

For SHA-256, SHAKE-256, and random bytes (everything *except* ML-DSA-65), prefer
`crypto.subtle` — it is hardware-accelerated in all browsers and adds zero
bundle size:

```typescript
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(hash);
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}
```

The WASM module's `getrandom` import is wired to `crypto.getRandomValues()` so
keygen uses the browser's CSPRNG.

### 6.4 The swappable `IdentityProvider` interface

Both the pure-TS and WASM packages implement the same `IdentityProvider`
interface, so the crypto backend is injectable:

```typescript
export interface IdentityProvider {
  generateKeypair(seed?: Uint8Array): Promise<AgentKeypair>;
  sign(secretKey: Uint8Array, msg: Uint8Array): Uint8Array;
  verify(sig: Uint8Array, msg: Uint8Array, publicKey: Uint8Array): boolean;
  agentId(publicKey: Uint8Array): string;
}
```

- `NobleIdentityProvider` — pure JS (Strategy A). Default in `@aafp/sdk`.
- `WasmIdentityProvider` — WASM-backed (Strategy B). Default in `@aafp/sdk-wasm`.
- A future `WebCryptoIdentityProvider` — if/when browsers add ML-DSA-65 to
  `crypto.subtle` (not expected before 2027).

---

## 7. Browser Agent Capabilities

### 7.1 What can a browser agent do?

A browser-resident AAFP agent is a full participant in the AAFP network, subject
to the browser's transport constraints. Concretely:

**As a client (primary v1 capability):**
- **Discover** agents by capability (`client.discover("translation")`).
- **Call** remote agents (`discovery.call(Request.text("hello"))`).
- **Stream** responses (`discovery.callStreaming(req)` → `for await`).
- **Register** agent records with a relay (for discovery by others).
- **Maintain identity** — generate and persist an ML-DSA-65 keypair in
  IndexedDB, present it in handshakes, sign messages.

**As a server (limited, via relay or server-side WebTransport):**
- **Serve lightweight capabilities** — a browser agent can register a capability
  (e.g. `browser-notifications`, `clipboard-access`, `local-storage`) and accept
  inbound calls *if* a relay or server-side WebTransport endpoint forwards
  connections to it. The browser cannot listen on a port directly.
- **Act as a relay** — a Service Worker (§8) can accept push notifications and
  forward them to other agents via AAFP.

### 7.2 What a browser agent cannot do (v1)

- **Listen on a UDP port.** No raw sockets. Inbound connections require a relay.
- **Run a Kademlia DHT node.** The DHT requires maintaining many UDP
  connections; not feasible in a browser. Discovery uses the relay directory or
  direct-address path.
- **Serve high-throughput capabilities.** The browser's transport (WebTransport
  over HTTP/3) is optimized for client-initiated streams. Server-mode
  performance is limited.
- **Persist keys to disk.** Keys live in IndexedDB / OPFS, not the filesystem.

### 7.3 Capability examples for browser agents

A browser agent is uniquely positioned to serve capabilities that *only a
browser can provide*:

| Capability | What it does | Why browser-only |
|------------|--------------|------------------|
| `browser.notifications` | Show a desktop notification | Requires Notification API |
| `clipboard.read` / `clipboard.write` | Read/write the system clipboard | Requires Clipboard API + user gesture |
| `geolocation` | Return the device's GPS coordinates | Requires Geolocation API + permission |
| `local-storage` | Read/write the origin's localStorage | Origin-scoped |
| `dom.snapshot` | Return a serialized DOM tree of the current page | Requires DOM access |
| `user.confirm` | Show a modal, return user's yes/no | Requires UI + user gesture |
| `push.relay` | Forward AAFP messages as Web Push notifications | Requires Service Worker + Push API |

These capabilities let cloud agents *call back into the browser* — e.g., a cloud
translation agent finishes a long job and calls the browser agent's
`browser.notifications` capability to alert the user. This is the inverse of the
typical "browser calls cloud" pattern, and it is unique to AAFP's P2P model.

---

## 8. Service Worker Agent

### 8.1 The role

A Service Worker is a browser-managed background script that persists across
page reloads, survives tab closure (within the browser's eviction policy), and
can receive push notifications even when no page is open. It is the browser
analog of a daemon.

An AAFP Service Worker agent fills three roles:

1. **Background AAFP relay** — maintains a WebSocket connection to the AAFP
   relay, receives inbound messages, and dispatches them to open pages (via
   `postMessage`) or shows notifications.
2. **Push notification handler** — receives Web Push notifications (triggered by
   a cloud agent calling the browser's `push.relay` capability via the relay)
   and surfaces them as OS-level notifications.
3. **Persistent identity** — stores the agent's ML-DSA-65 keypair in IndexedDB,
   accessible across page reloads. The Service Worker performs handshakes so the
   identity is stable.

### 8.2 Architecture

```
┌─────────────────── Browser ───────────────────────┐
│                                                    │
│  ┌─────────────┐   postMessage   ┌──────────────┐  │
│  │  Page (UI)  │ <─────────────> │  Service     │  │
│  │  React app  │                 │  Worker      │  │
│  └─────────────┘                 │  (AAFP agent)│  │
│                                  │              │  │
│                  IndexedDB       │  keypair,    │  │
│                  ◄──────────────►│  conn pool   │  │
│                                  └──────┬───────┘  │
│                                         │ WebSocket│
└─────────────────────────────────────────┼──────────┘
                                          │
                                  ┌───────▼───────┐
                                  │  AAFP relay   │
                                  │  (Rust, WS)   │
                                  └───────┬───────┘
                                          │ QUIC
                                  ┌───────▼───────┐
                                  │  Cloud agents │
                                  └───────────────┘
```

### 8.3 Service Worker lifecycle constraints

- **Activation:** The Service Worker is installed on first page visit, activated
  on next visit (or immediately via `skipWaiting`). The AAFP agent logic runs in
  the `activate` event.
- **Termination:** The browser may terminate the Service Worker when idle
  (typically after 30 seconds of inactivity in Chrome). The AAFP connection must
  be re-establishable. The relay holds pending messages and replays them on
  reconnect (a "wake on message" pattern via Web Push).
- **Push events:** `self.addEventListener("push", ...)` wakes the Service Worker
  and delivers a payload. The payload is an AAFP RPC frame (base64); the worker
  decodes it, performs the capability, and shows a notification.
- **No DOM access.** The Service Worker cannot manipulate the page directly. It
  posts messages to controlled pages via `clients.matchAll()`.

### 8.4 Reference: Service Worker agent skeleton

```typescript
// sw.ts — AAFP Service Worker agent

import { Agent, Request } from "@aafp/sdk";
import { WsGatewayTransport } from "@aafp/sdk/transport/ws-gateway";

let client: ConnectedAgent | null = null;

async function ensureConnected() {
  if (client) return client;
  const transport = await WsGatewayTransport.create("wss://relay.example.com/aafp-gateway");
  client = await Agent.connect().withTransport(transport).connect();
  // Register browser-only capabilities
  client.serveCapability("browser.notifications", async (req) => {
    const { title, body } = JSON.parse(req.body);
    await self.registration.showNotification(title, { body });
    return Response.text("ok");
  });
  return client;
}

self.addEventListener("activate", (event) => {
  event.waitUntil(ensureConnected());
});

self.addEventListener("push", (event) => {
  if (!event.data) return;
  const payload = event.data.text(); // base64 AAFP frame from relay
  event.waitUntil(
    ensureConnected().then(() =>
      self.registration.showNotification("AAFP", { body: payload })
    )
  );
});

self.addEventListener("message", (event) => {
  // Page requests an AAFP call — relay through the persistent connection
  if (event.data?.type === "aafp-call") {
    event.waitUntil(
      ensureConnected()
        .then((c) => c.discover(event.data.capability).call(Request.text(event.data.body)))
        .then((res) => event.source?.postMessage({ id: event.data.id, body: res.body }))
    );
  }
});
```

---

## 9. Web Worker Agent

### 9.1 The role

A Web Worker is a background thread within a page. Unlike a Service Worker, it
dies when the page closes, but it runs on a separate thread and does not block
the UI. The Web Worker agent's role is to **offload AAFP processing from the
main thread** — crypto (ML-DSA-65 sign/verify), CBOR encoding, handshake state
machine, and stream I/O — so the UI stays responsive (60 fps) even during
handshake-heavy workloads.

### 9.2 When to use a Web Worker vs. Service Worker

| | Service Worker | Web Worker |
|---|---|---|
| Lifetime | Persists across page reloads | Dies with page |
| Background (page closed) | **Yes** | No |
| Separate thread | Yes | **Yes** |
| Push notifications | **Yes** | No |
| DOM access | No | No |
| Use case | Persistent identity, push, relay | Offload CPU from UI |

A typical app uses **both**: a Service Worker for persistent identity and push,
and a Web Worker for per-page AAFP processing. The Service Worker holds the
keypair and relay connection; the Web Worker performs the handshake and RPC for
the active page, delegating identity operations to the Service Worker via
`postMessage`.

### 9.3 The WASM-in-Worker pattern

The WASM module (§2) should be instantiated **inside the Web Worker**, not the
main thread. WASM execution blocks the thread it runs on; ML-DSA-65 verify
(~150–300 µs in WASM) would cause a visible frame drop on the main thread. In a
Worker, it is invisible to the user.

```typescript
// worker.ts

import init, { Agent, Request } from "@aafp/sdk-wasm";

let agent: Agent | null = null;

self.onmessage = async (event) => {
  if (event.data.type === "init") {
    await init(event.data.wasmUrl); // instantiate WASM
    agent = await Agent.connect();
    self.postMessage({ type: "ready" });
  } else if (event.data.type === "call") {
    const res = await agent!.discover(event.data.capability)
      .call(Request.text(event.data.body));
    self.postMessage({ id: event.data.id, body: res.body });
  }
};
```

The main thread spawns the worker and proxies calls:

```typescript
// main.ts

const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
worker.postMessage({ type: "init", wasmUrl: "/aafp_sdk_wasm_bg.wasm" });

export function aafpCall(capability: string, body: string): Promise<string> {
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const handler = (e: MessageEvent) => {
      if (e.data.id === id) {
        worker.removeEventListener("message", handler);
        resolve(e.data.body);
      }
    };
    worker.addEventListener("message", handler);
    worker.postMessage({ type: "call", id, capability, body });
  });
}
```

---

## 10. WASM Bundle Size Optimization

Browser bundle size matters for time-to-interactive, especially on mobile. The
AAFP WASM module includes ML-DSA-65 (large polynomial tables), SHAKE-256, CBOR,
and the handshake state machine — a non-trivial payload. Optimization is
multi-layered.

### 10.1 Size budget

| Component | Raw WASM | gzipped | Notes |
|-----------|----------|---------|-------|
| `aafp-cbor` | ~15 KB | ~6 KB | Small encoder/decoder. |
| `aafp-crypto` (ML-DSA-65 + SHAKE) | ~180 KB | ~95 KB | Dominated by ML-DSA-65 tables. |
| `aafp-messaging` | ~10 KB | ~4 KB | Frame + RPC encoding. |
| `aafp-handshake` | ~20 KB | ~8 KB | State machine. |
| `aafp-sdk` shim | ~15 KB | ~6 KB | Simple API wiring. |
| **Total** | **~240 KB** | **~120 KB** | Before `wasm-opt`. |

After `wasm-opt -Oz` (§10.2), the gzipped total drops to ~90–100 KB. The JS
glue (`wasm-bindgen` output) adds ~8 KB gzipped. The full `@aafp/sdk-wasm`
package is ~100–110 KB gzipped — larger than the pure-TS SDK's ≤ 60 KB, but with
native-equivalent crypto performance.

### 10.2 `wasm-opt`

[`binaryen`](https://github.com/WebAssembly/binaryen)'s `wasm-opt` is the
standard WASM optimizer. Run it as a post-build step:

```bash
wasm-opt -Oz --strip-debug --strip-producers \
  -o aafp_sdk_wasm_bg.wasm \
  aafp_sdk_wasm_bg.wasm
```

- `-Oz` — optimize for size (aggressive dead-code elimination, constant folding,
  function inlining tuned for size).
- `--strip-debug` — remove debug symbols / name section.
- `--strip-producers` — remove the producers section (metadata).

Typical reduction: 20–35% on crypto-heavy WASM.

### 10.3 Tree shaking at the Rust level

`wasm-bindgen` + `wasm-pack` perform LTO (link-time optimization) to eliminate
unused code. Ensure `Cargo.toml` is configured:

```toml
# aafp-sdk-wasm/Cargo.toml
[profile.release]
opt-level = "z"      # optimize for size
lto = true            # link-time optimization
codegen-units = 1     # single codegen unit → better dead-code elimination
panic = "abort"       # no unwinding machinery (smaller)
strip = true          # strip symbols

[dependencies]
aafp-cbor = { path = "../aafp-cbor", default-features = false }
aafp-crypto = { path = "../aafp-crypto", default-features = false }
aafp-messaging = { path = "../aafp-messaging" }
aafp-handshake = { path = "../aafp-handshake" }
# Do NOT include aafp-transport-quic — it does not compile to WASM.
wasm-bindgen = "0.2"
wasm-bindgen-futures = "0.2"
getrandom = { version = "0.2", features = ["js"] }
```

Feature-gate anything optional. For example, the `X25519MLKEM768` KEX code is
only needed if the WASM module performs the KEX (it doesn't — WebTransport's TLS
does KEX). Gate it behind a `kex` feature that is off by default in the WASM
build.

### 10.4 Dynamic imports (JS side)

The JS glue should dynamically import the WASM module only when an AAFP
operation is requested, not at page load. This keeps the initial bundle small
and defers the ~100 KB WASM download until needed:

```typescript
// @aafp/sdk-wasm/index.ts

let wasmReady: Promise<typeof import("./aafp_sdk_wasm.js")> | null = null;

export async function loadWasm() {
  if (!wasmReady) {
    wasmReady = import("./aafp_sdk_wasm.js").then((mod) =>
      mod.default("/aafp_sdk_wasm_bg.wasm").then(() => mod)
    );
  }
  return wasmReady;
}

export async function connect(): Promise<Agent> {
  const { Agent } = await loadWasm();
  return Agent.connect();
}
```

With this pattern, a bundler (esbuild, Vite, Rollup) splits the WASM + glue into
a separate chunk loaded on demand. The main bundle includes only the
~2 KB `loadWasm` stub.

### 10.5 Lazy ML-DSA-65 tables

ML-DSA-65's public parameters include large precomputed tables (~120 KB raw).
These are constant data, not code. Two options:

1. **Embed in WASM** (default) — the tables are part of the `.wasm` binary,
   gzipped well (they are highly structured). Simplest; one download.
2. **Fetch at runtime** — store tables as a separate `.bin` file, fetch via
   `fetch()`, and pass to the WASM module. Allows caching tables independently
   of the WASM code (useful if the code updates but tables don't).

Option 1 is recommended for v1 (simpler, one file). Option 2 is a future
optimization.

---

## 11. Progressive Enhancement: WebSocket → WebTransport

### 11.1 The principle

AAFP's browser transport follows **progressive enhancement**: start with the
most universally supported transport (WebSocket relay), then upgrade to
WebTransport when available. The user experience is:

1. **Page loads** → SDK opens a WebSocket to the relay immediately. The user can
   make AAFP calls right away (low-latency if the relay is nearby).
2. **Feature detection** → the SDK checks `typeof WebTransport !== "undefined"`.
3. **Upgrade** → if WebTransport is available, the SDK opens a WebTransport
   session in parallel. Once ready, new calls use WebTransport (lower latency,
   true P2P). The WebSocket is kept as a backup or closed.
4. **Fallback** → if WebTransport fails (network blocks UDP), the SDK stays on
   WebSocket. No user-visible error.

### 11.2 The auto-detection factory

```typescript
// @aafp/sdk/transport/auto.ts

export function autoTransportFactory(gatewayUrl?: string): TransportFactory {
  return {
    async create(opts): Promise<Transport> {
      // 1. Node.js 25+ with node:quic (full QUIC, best performance)
      if (typeof process !== "undefined" && hasNodeQuic()) {
        const { NodeQuicTransport } = await import("./node-quic.js");
        return new NodeQuicTransport(opts);
      }
      // 2. Browser / Deno with WebTransport (HTTP/3, P2P)
      if (typeof WebTransport !== "undefined") {
        const { WebTransportTransport } = await import("./webtransport.js");
        return WebTransportTransport.create(opts.webTransportUrl!, {});
      }
      // 3. WebSocket gateway (universal fallback — works everywhere)
      const { WsGatewayTransport } = await import("./ws-gateway.js");
      return WsGatewayTransport.create(gatewayUrl ?? defaultGatewayUrl());
    },
  };
}
```

The dynamic `import()` calls are critical: bundlers split each transport into a
separate chunk, and only the chunk for the active runtime is loaded. A browser
bundle never includes the `node:quic` code path.

### 11.3 Upgrade in practice

The `ConnectionPool` (Phase 4) can hold connections over multiple transports
simultaneously. During the upgrade window:

```
t=0ms   WebSocket connected → calls start flowing
t=50ms  WebTransport session.ready → new calls use WebTransport
t=100ms WebSocket closed (after in-flight calls drain)
```

This is transparent to the application — the `ConnectedAgent` API is the same
regardless of transport. The only observable difference is latency.

---

## 12. Security: Sandboxing, CORS, CSP

### 12.1 The browser sandbox

The browser is the most sandboxed runtime AAFP targets. This is a security
*advantage* — a compromised AAFP agent in a browser cannot access the
filesystem, spawn processes, or open arbitrary sockets. The constraints are:

- **Same-origin policy.** The WASM module and all JS run in the page's origin.
  AAFP connections to other origins are via WebTransport / WebSocket (which are
  not subject to CORS in the same way as `fetch`, but are subject to mixed-
  content and certificate-validation rules).
- **Secure context required.** WebTransport and `crypto.subtle` require HTTPS
  (or `localhost`). A page served over HTTP cannot be an AAFP agent.
- **No `eval` / `Function()` in CSP.** If the page's CSP forbids `wasm-unsafe-eval`,
  the WASM module cannot instantiate. The CSP must include `script-src 'self'
  'wasm-unsafe-eval'`.

### 12.2 Content Security Policy for AAFP agents

A recommended CSP for a page hosting an AAFP browser agent:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'wasm-unsafe-eval';
  connect-src wss://relay.example.com https://relay.example.com;
  worker-src 'self';
  img-src 'self' data:;
  style-src 'self' 'unsafe-inline';
```

- `script-src 'wasm-unsafe-eval'` — allows WASM instantiation (required for
  `@aafp/sdk-wasm`; not needed for pure-TS `@aafp/sdk`).
- `connect-src wss://... https://...` — allows WebSocket and WebTransport to
  the relay. List all relay endpoints the app may use.
- `worker-src 'self'` — allows Web Worker / Service Worker scripts from the same
  origin.

### 12.3 CORS and WebTransport

WebTransport is **not** subject to CORS in the same way as `fetch`. The browser
does not enforce a same-origin policy on WebTransport sessions — any origin can
open a WebTransport session to any server (subject to the server's certificate
being valid). This is by design (WebTransport is a bidirectional transport, not
a request/response API).

However, the AAFP *relay's* WebSocket endpoint **is** subject to CORS if it
responds to an HTTP OPTIONS preflight. The relay should set
`Access-Control-Allow-Origin` appropriately (or use `*` if the relay is public
and does not handle credentials).

### 12.4 Key storage security

The agent's ML-DSA-65 keypair is the agent's identity. In the browser, it is
stored in **IndexedDB** (not `localStorage` — `localStorage` is synchronous and
visible to any script in the origin). Recommendations:

- Store the secret key encrypted with a key derived from a WebCrypto
  `CryptoKey` (non-extractable, scoped to the origin).
- Use IndexedDB with a dedicated database (`aafp-identity`), not a shared one.
- Never log or serialize the secret key to JSON.
- For high-security agents, use **WebAuthn** (Platform Authenticator) to gate
  key access — the key is only usable after a biometric / PIN prompt.

### 12.5 Relay trust model

The WebSocket relay is a trusted intermediary. It sees all traffic (encrypted
at the TLS layer, but the relay terminates TLS). Mitigations:

- **End-to-end ML-DSA-65 signatures.** AAFP RPC messages are signed by the
  originating agent. The relay cannot forge signatures (no private key). The
  receiver verifies the signature end-to-end, regardless of the relay.
- **Relay selection.** The browser agent connects to a relay it trusts (same
  origin, or a known public relay). The relay URL is configured by the app, not
  auto-discovered.
- **Future: relay-to-relay forwarding.** A future enhancement routes traffic
  through multiple relays (onion-style) so no single relay sees both
  endpoints. Not in v1.

---

## 13. Concrete Example: Browser AI Assistant

### 13.1 Scenario

A browser-based AI assistant (a React SPA) helps a user draft emails. When the
user clicks "Improve tone", the assistant:

1. Discovers a cloud-based `writing.coach` agent via AAFP.
2. Sends the draft text as an AAFP RPC.
3. Streams the improved draft back token-by-token (server-streaming RPC).
4. When done, calls the browser's own `browser.notifications` capability (via
   the Service Worker) to notify the user if the tab is in the background.

### 13.2 The code

```typescript
// app.ts — main thread (React)

import { Agent, Request, Params } from "@aafp/sdk";
import { autoTransportFactory } from "@aafp/sdk";

const client = await Agent.connect()
  .withTransport(autoTransportFactory("wss://relay.example.com/aafp-gateway"))
  .connect();

async function improveTone(draft: string): Promise<string> {
  // Discover a cloud writing.coach agent
  const discovery = await client.discover("writing.coach");

  // Stream the improved draft token-by-token
  const stream = await discovery.callStreaming(
    Request.text(draft)
  );

  let result = "";
  for await (const chunk of stream) {
    result += chunk.body;
    // Update UI incrementally (React state)
    setDraftText(result);
  }
  return result;
}

// When the user clicks "Improve tone":
improveToneButton.onclick = async () => {
  const draft = draftTextarea.value;
  await improveTone(draft);

  // If the tab is backgrounded, notify via the Service Worker
  if (document.visibilityState === "hidden") {
    navigator.serviceWorker.controller?.postMessage({
      type: "aafp-call",
      capability: "browser.notifications",
      body: JSON.stringify({ title: "Draft ready", body: "Your improved email is ready." }),
    });
  }
};
```

### 13.3 The cloud agent (Rust, server-side)

The `writing.coach` agent runs on a cloud server with full QUIC. It registers
its capability in the DHT and accepts AAFP connections directly (no relay
needed on the server side). The browser reaches it via the relay (WebSocket →
QUIC) or directly via WebTransport if the server runs an HTTP/3 endpoint.

```rust
// cloud writing.coach agent (Rust)
let agent = Agent::serve()
    .capability("writing.coach")
    .on_capability("writing.coach", |req, ctx| async move {
        let draft = req.body();
        let improved = llm_improve_tone(&draft).await;
        // Stream tokens back via the MORE flag
        stream_response(improved, ctx).await
    })
    .bind("0.0.0.0:443")?
    .start().await?;
```

### 13.4 The Service Worker (push notifications)

```typescript
// sw.ts
self.addEventListener("message", async (event) => {
  if (event.data?.type === "aafp-call" && event.data.capability === "browser.notifications") {
    const { title, body } = JSON.parse(event.data.body);
    await self.registration.showNotification(title, { body });
  }
});
```

### 13.5 What makes this possible

- **Discovery.** The browser agent does not hardcode the cloud agent's address;
  it discovers `writing.coach` via the relay directory (and, in the future, the
  DHT).
- **Streaming.** AAFP's `MORE` flag (RFC-0002 §4.1) streams tokens without
  reconnection. The browser's `for await` consumes them as they arrive.
- **PQ identity.** The browser agent's ML-DSA-65 keypair (in IndexedDB) signs
  the RPC. The cloud agent verifies the signature — it knows *which* browser
  agent called it, even through the relay.
- **Bidirectional capability.** The browser agent is not just a client — it
  *serves* `browser.notifications`, callable by cloud agents (via the relay).
  This is the P2P symmetry that MCP and A2A cannot offer in the browser.

---

## 14. Build Instructions

### 14.1 Prerequisites

```bash
# 1. Rust toolchain with WASM target
rustup target add wasm32-unknown-unknown
cargo install wasm-pack      # builds + packages WASM for npm
cargo install wasm-opt       # binaryen optimizer (optional but recommended)

# 2. Node.js + npm (for the JS wrapper package)
node --version  # >= 20

# 3. (Optional) wasm-bindgen-cli for debugging
cargo install wasm-bindgen-cli
```

### 14.2 Build the WASM module

```bash
cd aafp-sdk-wasm/

# Development build (fast, with debug symbols, no optimization)
wasm-pack build --target web --dev

# Production build (optimized for size)
wasm-pack build --target web --release

# Post-optimize with wasm-opt
wasm-opt -Oz --strip-debug --strip-producers \
  -o pkg/aafp_sdk_wasm_bg.wasm \
  pkg/aafp_sdk_wasm_bg.wasm
```

`wasm-pack --target web` generates:
- `pkg/aafp_sdk_wasm.js` — JS glue (ESM, importable by bundlers).
- `pkg/aafp_sdk_wasm_bg.wasm` — the WASM binary.
- `pkg/aafp_sdk_wasm.d.ts` — TypeScript types.

### 14.3 Package for npm

```bash
cd aafp-sdk-wasm/pkg/

# Copy the JS wrapper and transport adapters
cp ../js/index.ts .
cp ../js/transport/*.ts ./transport/

# Initialize package.json
cat > package.json <<'EOF'
{
  "name": "@aafp/sdk-wasm",
  "version": "0.1.0",
  "type": "module",
  "main": "./index.js",
  "types": "./index.d.ts",
  "exports": {
    ".": "./index.js",
    "./transport/webtransport": "./transport/webtransport.js",
    "./transport/ws-gateway": "./transport/ws-gateway.js"
  },
  "files": ["index.js", "index.d.ts", "aafp_sdk_wasm.js", "aafp_sdk_wasm_bg.wasm", "transport/"],
  "sideEffects": false
}
EOF

npm publish --access public
```

### 14.4 Verify bundle size

```bash
# Gzipped size of the WASM binary
gzip -c pkg/aafp_sdk_wasm_bg.wasm | wc -c
# Target: ≤ 110 KB (100,000 bytes) gzipped

# Total package size (WASM + JS glue)
du -sh pkg/
```

### 14.5 Local browser test

```bash
# 1. Start an AAFP relay with WebSocket gateway
cargo run --bin aafp-gateway -- --ws 0.0.0.0:9000

# 2. Start an echo agent (Rust, server-side)
cargo run --example echo-server -- --bind 127.0.0.1:443

# 3. Serve the browser example
cd examples/browser-echo/
npx http-server . --cors -p 8080

# 4. Open https://localhost:8080 (use a self-signed cert for WebTransport)
#    The page connects via WebTransport (or WS fallback) and calls echo.
```

### 14.6 CI pipeline (GitHub Actions)

```yaml
# .github/workflows/wasm-build.yml
name: WASM Build
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions-rust/setup-rust@v1
        with:
          targets: wasm32-unknown-unknown
      - run: cargo install wasm-pack wasm-opt
      - run: cd aafp-sdk-wasm && wasm-pack build --target web --release
      - run: wasm-opt -Oz --strip-debug --strip-producers -o pkg/aafp_sdk_wasm_bg.wasm pkg/aafp_sdk_wasm_bg.wasm
      - name: Assert bundle size
        run: |
          SIZE=$(gzip -c pkg/aafp_sdk_wasm_bg.wasm | wc -c)
          echo "Gzipped WASM size: $SIZE bytes"
          if [ "$SIZE" -gt 110000 ]; then
            echo "ERROR: WASM bundle exceeds 110 KB gzipped"
            exit 1
          fi
      - uses: actions/upload-artifact@v4
        with:
          name: aafp-sdk-wasm
          path: aafp-sdk-wasm/pkg/
```

### 14.7 Cross-verification (A-10 test vectors)

The WASM ML-DSA-65 implementation must produce byte-identical signatures to the
Rust native build (same seed → same key → same deterministic signature). Run
the A-10 test vectors through the WASM module in a headless browser:

```bash
# Run in Playwright headless Chrome
npx playwright test tests/wasm-ml-dsa.test.ts
```

```typescript
// tests/wasm-ml-dsa.test.ts
import { test, expect } from "@playwright/test";
import init, { NobleIdentityProvider } from "@aafp/sdk-wasm";

test("ML-DSA-65 A-10 vector", async ({ page }) => {
  await page.goto("https://localhost:8080/test.html");
  const result = await page.evaluate(async () => {
    await init("/aafp_sdk_wasm_bg.wasm");
    const provider = new NobleIdentityProvider();
    const seed = new Uint8Array(32); // A-10 seed
    const keys = await provider.generateKeypair(seed);
    const sig = provider.sign(keys.secretKey, new TextEncoder().encode("test"));
    return { publicKey: keys.publicKey, sig };
  });
  // Assert against the Rust-generated golden trace
  expect(result.sig).toEqual(expectedGoldenSignature);
});
```

---

## 15. Roadmap and Open Questions

### 15.1 Phasing

| Phase | Deliverable | Status |
|-------|-------------|--------|
| Phase 6 (current) | Pure-TS browser support (`@aafp/sdk`), WebTransport + WS gateway, `@noble` crypto | In progress |
| Phase 7 | `@aafp/sdk-wasm` — WASM-compiled crypto + protocol, `wasm-bindgen` bindings | Planned |
| Phase 8 | Framework adapters (React, Vue, Svelte) + Service Worker / Web Worker patterns | Planned |
| Phase 9 | `@aafp/sdk-native` (napi-rs) for Node.js max performance | Planned |
| Future | Browser-side `Agent.serve()` via server-side WebTransport endpoint | Research |

### 15.2 Open questions

1. **WASM threading.** `wasm32-unknown-unknown` with shared memory + atomics
   would allow `rayon`-parallel ML-DSA-65 (multi-threaded verify). Browser
   support for threaded WASM (SharedArrayBuffer + COOP/COEP headers) is
   available but requires the page to be cross-origin isolated. Is the
   performance gain worth the COOP/COEP requirement? *Tentative: no for v1;
   revisit if handshake-heavy browser workloads emerge.*

2. **WebTransport over QUIC qlog.** The browser does not expose QUIC-level
   diagnostics. For debugging AAFP-over-WebTransport, do we need a JS-side qlog
   emulator that reconstructs frame-level events from the `BidiStream`
   interface? *Tentative: yes, as a dev-tools package, not in the core SDK.*

3. **Relay-to-relay forwarding.** For privacy, can the browser agent route
   through multiple relays (onion-style) so no single relay sees both
   endpoints? *Research; not in v1.*

4. **WebCrypto ML-DSA-65.** If/when browsers add ML-DSA-65 to `crypto.subtle`,
   the `WasmIdentityProvider` can be replaced with a `WebCryptoIdentityProvider`
   (zero bundle cost, hardware-accelerated). Track the W3C WebCrypto CG
   discussions on PQ algorithm registration. *Not expected before 2027.*

5. **Service Worker eviction.** Chrome evicts Service Workers after ~30s idle.
   For long-lived AAFP connections, is the wake-on-push pattern sufficient, or
   do we need a dedicated push server that holds messages and replays on
   reconnect? *Tentative: the relay already holds messages; the SW reconnects
   on push.*

---

## References

- `TYPESCRIPT_SDK_DESIGN.md` §3.1 — Approach A (WASM binding) analysis
- `TYPESCRIPT_SDK_DESIGN.md` §8 — Browser vs Node.js Strategy (transport split, WebTransport considerations, browser agent API, WS gateway fallback)
- `builder-prompts/TS_PHASE_6_BROWSER.md` — Phase 6 implementation prompt (WebTransport adapter, WS gateway, isomorphic API, WebCrypto, bundle optimization, framework integration)
- RFC-0002 §5 — v1 handshake state machine (transport-agnostic)
- RFC-0003 — Identity & authentication (ML-DSA-65)
- RFC-0005 — Handler error categories
- FIPS 204 — Module-Lattice-Based Digital Signature Standard (ML-DSA-65)
- [`wasm-bindgen`](https://rustwasm.github.io/wasm-bindgen/) — Rust ↔ JS bindings
- [`wasm-pack`](https://rustwasm.github.io/wasm-pack/) — WASM build + npm packaging
- [`binaryen` / `wasm-opt`](https://github.com/WebAssembly/binaryen) — WASM optimizer
- [`@noble/post-quantum`](https://github.com/paulmillr/noble-post-quantum) — pure-JS ML-DSA-65
- [WebTransport API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport) — browser support, API reference
- [caniuse: WebTransport](https://caniuse.com/webtransport) — Chrome 97+, Safari 17+, Firefox experimental
- [Service Worker API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)
- [Web Workers API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API)
- [WebCrypto API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)
