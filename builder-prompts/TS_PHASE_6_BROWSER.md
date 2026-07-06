# Builder Prompt — TypeScript SDK Phase 6: Browser Compatibility

**Target:** `@aafp/sdk` pure-TypeScript implementation
**Phase:** 6 of the implementation roadmap (see `TYPESCRIPT_SDK_DESIGN.md` §14, "Phase 7: MCP integration + browser")
**Goal:** Make the AAFP TypeScript SDK run in browsers, Deno, and Bun with the same isomorphic API that works in Node.js, using WebTransport as the primary browser transport and a WebSocket-to-QUIC relay as the universal fallback.
**Design source of truth:** `TYPESCRIPT_SDK_DESIGN.md` §6 (Transport Abstraction), §8 (Browser vs Node.js Strategy), §11 (Deno and Bun Support), §12 (Package Distribution)

---

## 1. Mission

Implement browser compatibility for the `@aafp/sdk` pure-TypeScript package. After this phase, a developer can write a single TypeScript module that:

- Runs unchanged in **Node.js 25+** (via `node:quic`), **Chrome/Edge** (via WebTransport), **Firefox/Safari** (via WebTransport or WebSocket fallback), **Deno** (via WebTransport), and **Bun** (via WebSocket gateway).
- Uses the identical `Agent.connect()` / `client.discover(cap).call(req)` API surface defined in Simple API v2 — no `if (isBrowser)` branches in user code.
- Performs ML-DSA-65 post-quantum identity operations using WebCrypto where available and a WASM/pure-JS fallback elsewhere.
- Tree-shakes down to a minimal client-only bundle when imported into a browser app (React/Vue/Svelte).

The transport is selected at runtime by feature detection, not by build-time flags. The handshake, framing, CBOR, and RPC layers are transport-agnostic and already implemented in Phases 1–5; this phase wires them to browser-capable transports and hardens the crypto/identity layer for non-Node runtimes.

---

## 2. Scope and Deliverables

### 2.1 In scope

1. **`WebTransportTransport`** — a `Transport` implementation wrapping the browser `WebTransport` (HTTP/3) API, mapping `WebTransportBidirectionalStream` to the existing `BidiStream` interface.
2. **`WsGatewayTransport`** — a `Transport` implementation that connects to an AAFP relay (`aafp gateway --ws`) over WebSocket and multiplexes logical bidi streams over a single WebSocket using a stream-id framing protocol.
3. **`WsGatewayClient`** — the browser-side of the WebSocket-to-QUIC bridge, including stream multiplexing, backpressure, and reconnection.
4. **Isomorphic API surface** — ensure `Agent`, `Request`, `Response`, `Params`, `ConnectedAgent`, `DiscoveryBuilder` work with no Node-specific globals at the top level. All Node-only APIs (`node:quic`, `node:net`, `node:crypto`) are dynamically imported only inside their transport modules.
5. **WebCrypto crypto provider** — an `IdentityProvider` implementation using `crypto.subtle` for SHA-256/SHAKE and `@noble/post-quantum` (pure JS, no Node `Buffer`) for ML-DSA-65, with a documented WASM fallback hook.
6. **Auto-detection transport factory** — runtime feature detection selecting `node:quic` → WebTransport → WebSocket gateway, in that order.
7. **Bundle optimization** — package.json `exports` map, conditional imports, tree-shakeable entry points, and a pre-bundled ESM CDN build.
8. **Framework integration patterns** — reference adapters for React (hook), Vue (composable), and Svelte (store) that wrap `ConnectedAgent` for UI reactivity.
9. **Deno and Bun smoke tests** — verify the universal ESM build loads and performs an echo RPC in both runtimes.
10. **Browser echo example** — a client-only HTML/TS example that discovers an `echo` capability and calls it over WebTransport.

### 2.2 Out of scope (deferred)

- Server-side WebTransport endpoint (`aafp gateway --webtransport`) — that is Rust-side work tracked separately; this phase only implements the TS client side and assumes a compatible server exists for testing.
- Full Kademlia DHT in the browser — discovery uses the relay directory / direct-address path for v1.
- `@aafp/sdk-native` napi-rs addon — Phase 9.
- Browser-side `Agent.serve()` — browsers only implement the WebTransport client side; browser agents are clients only for v1 (see §8.3 of the design doc).

---

## 3. Architectural Context

### 3.1 The transport split

| Runtime | Transport | Notes |
|---------|-----------|-------|
| Node.js 25+ | `node:quic` (experimental) | Full QUIC, ALPN `aafp/1` |
| Node.js < 25 | WebSocket gateway or `@aafp/sdk-native` | LTS users need a fallback |
| Browser (Chrome/Edge 97+) | WebTransport (HTTP/3) | Primary browser path |
| Browser (Firefox 114+ / Safari 26.4+) | WebTransport (HTTP/3) | Broadly available since March 2026 |
| Browser (older / restricted networks) | WebSocket gateway | Universal fallback |
| Deno | WebTransport (Deno supports it) | Deno also has `Deno.connect` UDP |
| Bun | WebSocket gateway (Bun lacks QUIC) | Or native addon if Bun napi matures |

### 3.2 WebTransport considerations

WebTransport is HTTP/3-based, not raw QUIC. Key differences the implementation must account for:

- **ALPN:** WebTransport uses `h3` ALPN, not `aafp/1`. The AAFP handshake still runs on stream 0 (a WebTransport bidi stream), but the TLS layer is HTTP/3's, not AAFP's custom ALPN. This is acceptable — the AAFP handshake provides application-layer identity (ML-DSA-65) independent of TLS.
- **PQ TLS:** WebTransport uses the browser's TLS stack, which may not support `X25519MLKEM768` yet. The AAFP handshake's ML-DSA-65 signatures provide post-quantum *identity* even if the TLS KEX is classical. This is a documented trade-off: PQ identity + classical transport confidentiality, upgradeable when browsers add PQ KEX. Document this in a comment on `WebTransportTransport`.
- **Server-side WebTransport:** Accepting browser connections requires an HTTP/3 endpoint that speaks WebTransport. The Rust `aafp-transport-quic` crate (quinn) can be extended, or a thin HTTP/3 gateway bridges browser WebTransport → internal QUIC. This phase assumes such a server exists for interop testing.

### 3.3 Browser-specific limitations

The implementation must explicitly handle these constraints — do not assume Node APIs exist:

1. **No raw QUIC.** Browsers cannot open UDP sockets. There is no `node:quic`, no `quinn`, no `msquic`. The only QUIC-like API is WebTransport (HTTP/3), which does not expose raw QUIC streams, ALPN negotiation, or custom TLS certificates.
2. **No `msquic` / native QUIC libraries.** Any transport that requires a native QUIC stack is unavailable. The WebSocket gateway is the only path to real QUIC (via the Rust relay) when WebTransport is missing.
3. **No `node:crypto`.** Use WebCrypto (`crypto.subtle`) for SHA-256, SHAKE-256, and random bytes. ML-DSA-65 is not in WebCrypto yet, so use `@noble/post-quantum` (pure JS) or a WASM module. Never call `require("node:crypto")` at module top level.
4. **No `Buffer`.** Use `Uint8Array` everywhere. If interop with Node code paths needs `Buffer`, convert at the boundary with `Buffer.from(arr)` inside a Node-only dynamically imported module.
5. **No `process`, no `require`, no `__dirname`.** The top-level SDK code must not reference these. Use feature detection (`typeof process !== "undefined"`, `typeof WebTransport !== "undefined"`) inside the auto-detection factory only.
6. **No filesystem, no `fs`.** Key persistence in the browser must use `localStorage` / `IndexedDB` (provided by a `KeyStore` abstraction, not hardcoded).
7. **CORS and mixed content.** WebTransport requires HTTPS (or `localhost`). A page served over HTTP cannot open WebTransport. Document this in the browser quickstart.
8. **Streaming backpressure.** WebTransport streams have their own flow control; map it to the `BidiStream` `write()` backpressure semantics (await the write promise before writing more).

---

## 4. Transport Interface (recap — already implemented in Phase 2)

The transport abstraction is the seam this phase plugs into. Do not modify these interfaces; implement against them.

```typescript
// src/transport/interface.ts (existing)

export interface BidiStream {
  write(data: Uint8Array): Promise<void>;
  finish(): Promise<void>;
  read(): Promise<Uint8Array | null>;
  reset(code?: number): Promise<void>;
}

export interface Connection {
  openBidiStream(): Promise<BidiStream>;
  acceptBidiStream(): Promise<BidiStream>;
  close(): Promise<void>;
  readonly remoteAddr: string;
}

export interface Transport {
  dial(addr: Multiaddr): Promise<Connection>;
  accept(): Promise<Connection>;
  readonly localAddr: Multiaddr;
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

---

## 5. WebTransport Transport Adapter

Implement `src/transport/webtransport.ts`. This is the primary browser transport for Chrome/Edge/Firefox/Safari.

### 5.1 Requirements

- Wrap the browser `WebTransport` constructor (`new WebTransport(url, opts)`).
- Map `WebTransportBidirectionalStream` to `BidiStream`: `writable.getWriter()` for `write()`/`finish()`, `readable.getReader()` for `read()`, and `sendReset()` / `receiveReset()` events for `reset()`.
- Map a `WebTransport` session to `Connection`: `createBidirectionalStream()` for `openBidiStream()`, `incomingBidirectionalStreams` async iterable for `acceptBidiStream()`.
- The `dial(addr)` method converts an AAFP multiaddr (e.g. `/ip4/1.2.3.4/udp/443/quic-v1/webtransport`) to a WebTransport URL (`https://1.2.3.4:443/aafp`). Document the mapping.
- Pass `serverCertificateHashes` option when the relay uses a self-signed cert (for local dev). In production, rely on the browser's CA validation.
- Await `transport.ready` before returning the `Connection`.
- Handle `transport.closed` promise (it rejects on error) and propagate to `Connection.close()`.

### 5.2 Reference implementation skeleton

```typescript
// src/transport/webtransport.ts

import type { BidiStream, Connection, Transport, Multiaddr } from "./interface.js";

/**
 * Browser WebTransport (HTTP/3) transport.
 *
 * WebTransport is HTTP/3-based, not raw QUIC. The ALPN is `h3`, not `aafp/1`.
 * The AAFP handshake still runs on stream 0 (a WebTransport bidi stream), but
 * the TLS layer is the browser's, not AAFP's custom ALPN. The AAFP handshake
 * provides application-layer identity (ML-DSA-65) independent of TLS.
 *
 * PQ TLS note: the browser's TLS stack may not support X25519MLKEM768 yet.
 * The AAFP handshake's ML-DSA-65 signatures provide post-quantum *identity*
 * even if the TLS KEX is classical. This is a documented trade-off, upgradeable
 * when browsers add PQ KEX.
 */
export class WebTransportTransport implements Transport {
  private session: WebTransport;
  readonly localAddr: Multiaddr;

  private constructor(session: WebTransport, localAddr: Multiaddr) {
    this.session = session;
    this.localAddr = localAddr;
  }

  static async create(url: string, opts: WebTransportOptions): Promise<WebTransportTransport> {
    const session = new WebTransport(url, opts);
    await session.ready;
    const localAddr = parseWebTransportUrl(url);
    return new WebTransportTransport(session, localAddr);
  }

  async dial(addr: Multiaddr): Promise<Connection> {
    // For WebTransport, dial and connect are the same — the session IS the connection.
    return new WebTransportConnection(this.session, addrToString(addr));
  }

  async accept(): Promise<Connection> {
    // Browser agents are client-only for v1. Server mode requires a server-side
    // WebTransport endpoint, which is not implemented in browsers.
    throw new Error("Agent.serve() is not supported in the browser for v1. Use a relay or server-side WebTransport endpoint.");
  }

  async close(): Promise<void> {
    await this.session.close();
  }
}

class WebTransportConnection implements Connection {
  constructor(private session: WebTransport, readonly remoteAddr: string) {}

  async openBidiStream(): Promise<BidiStream> {
    const stream = await this.session.createBidirectionalStream();
    return new WebTransportBidiStream(stream);
  }

  async acceptBidiStream(): Promise<BidiStream> {
    const reader = this.session.incomingBidirectionalStreams.getReader();
    const { value: stream, done } = await reader.read();
    if (done || !stream) throw new Error("WebTransport session closed");
    return new WebTransportBidiStream(stream);
  }

  async close(): Promise<void> {
    await this.session.close();
  }
}

class WebTransportBidiStream implements BidiStream {
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private reader: ReadableStreamDefaultReader<Uint8Array>;

  constructor(stream: WebTransportBidirectionalStream) {
    this.writer = stream.writable.getWriter();
    this.reader = stream.readable.getReader();
  }

  async write(data: Uint8Array): Promise<void> {
    await this.writer.write(data);
  }

  async finish(): Promise<void> {
    await this.writer.close();
  }

  async read(): Promise<Uint8Array | null> {
    const { value, done } = await this.reader.read();
    return done ? null : (value as Uint8Array);
  }

  async reset(code = 0): Promise<void> {
    try { this.writer.abort(code); } catch { /* already closed */ }
    try { this.reader.cancel(code); } catch { /* already closed */ }
  }
}

/** Convert an AAFP multiaddr to a WebTransport URL. */
function parseWebTransportUrl(url: string): Multiaddr {
  // https://host:port/aafp  →  /dns4/host/udp/port/quic-v1/webtransport
  // Implementation parses the URL and builds the multiaddr.
  throw new Error("TODO: implement multiaddr <-> WebTransport URL conversion");
}

export class WebTransportTransportFactory implements TransportFactory {
  constructor(private url: string, private opts: WebTransportOptions = {}) {}

  async create(): Promise<Transport> {
    return WebTransportTransport.create(this.url, this.opts);
  }
}
```

### 5.3 Feature detection

```typescript
export function isWebTransportAvailable(): boolean {
  return typeof WebTransport !== "undefined";
}
```

---

## 6. WebSocket-to-QUIC Bridge Client

Implement `src/transport/ws-gateway.ts`. This is the universal fallback for Firefox/Safari edge cases, old Node, restricted networks, and Bun.

### 6.1 Protocol design

The AAFP relay (`aafp gateway --ws`) exposes a single WebSocket endpoint. The browser client multiplexes logical bidi streams over this one WebSocket using a small framing layer:

```
Frame layout (on the WebSocket, binary messages):
  [4 bytes: streamId (u32 big-endian)]
  [1 byte:  frame type]
  [4 bytes: payload length (u32 big-endian)]
  [N bytes: payload]

Frame types:
  0x01 OPEN    — client opens a new logical stream (server assigns/echoes streamId)
  0x02 DATA    — payload bytes for the stream
  0x03 FIN     — sender half-closed (no payload)
  0x04 RESET   — stream aborted (payload = 1-byte reset code)
  0x05 PING    — keepalive (no payload)
  0x06 PONG    — keepalive response
```

The relay translates each logical stream to a real QUIC bidi stream on the AAFP network side. From the SDK's perspective, each logical stream is a `BidiStream` and the WebSocket is a `Connection` that can open many streams.

### 6.2 Requirements

- `WsGatewayTransport.create(url)` opens a WebSocket, waits for `open`, and returns a `WsGatewayConnection`.
- `WsGatewayConnection.openBidiStream()` allocates a new stream id (client side: odd ids; server side: even), sends an `OPEN` frame, and returns a `WsGatewayBidiStream` backed by a pending-write queue and an incoming-data buffer.
- `WsGatewayBidiStream.write()` sends `DATA` frames; `finish()` sends `FIN`; `reset()` sends `RESET`. `read()` returns a promise that resolves when a `DATA` frame arrives for this stream id, or `null` on `FIN`/`RESET`.
- Multiplexing: a single reader loop reads frames off the WebSocket and dispatches to the correct `WsGatewayBidiStream` by stream id. Use a `Map<number, WsGatewayBidiStream>` and resolve pending `read()` promises.
- Backpressure: if the WebSocket buffer exceeds a high-water mark (e.g. 1 MiB), `write()` should await a drain event before resolving, to avoid unbounded memory growth.
- Reconnection: on unexpected WebSocket close, emit an error on all open streams and allow the `ConnectionPool` (Phase 4) to redial. Full transparent reconnection is deferred; v1 fails fast.
- Keepalive: send a `PING` every 30s of idle; expect `PONG` within 10s or close the socket.
- Binary mode: the WebSocket must be opened with `binaryType = "arraybuffer"`; convert `ArrayBuffer` to `Uint8Array` at the boundary.

### 6.3 Reference implementation skeleton

```typescript
// src/transport/ws-gateway.ts

import type { BidiStream, Connection, Transport, Multiaddr } from "./interface.js";

const FRAME_OPEN = 0x01;
const FRAME_DATA = 0x02;
const FRAME_FIN = 0x03;
const FRAME_RESET = 0x04;
const FRAME_PING = 0x05;
const FRAME_PONG = 0x06;

/**
 * WebSocket fallback transport. Connects to an AAFP relay (`aafp gateway --ws`)
 * which translates WebSocket frames ↔ AAFP QUIC streams. Used when neither
 * node:quic nor WebTransport is available (old Node, restricted networks, Bun,
 * older Firefox/Safari). The API is identical to the other transports; only
 * latency and the P2P property differ — every message goes browser → relay →
 * QUIC → agent.
 */
export class WsGatewayTransport implements Transport {
  readonly localAddr: Multiaddr;

  private constructor(private ws: WebSocket, localAddr: Multiaddr) {
    this.localAddr = localAddr;
  }

  static async create(url: string): Promise<WsGatewayTransport> {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    await once(ws, "open");
    return new WsGatewayTransport(ws, parseWsUrl(url));
  }

  async dial(addr: Multiaddr): Promise<Connection> {
    // The WebSocket itself is the connection; the relay dials the real QUIC peer.
    return new WsGatewayConnection(this.ws, addrToString(addr));
  }

  async accept(): Promise<Connection> {
    throw new Error("WsGatewayTransport does not support server mode in the browser");
  }

  async close(): Promise<void> {
    this.ws.close();
  }
}

class WsGatewayConnection implements Connection {
  private nextStreamId = 1; // client-initiated streams use odd ids
  private streams = new Map<number, WsGatewayBidiStream>();
  private readerLoop: Promise<void>;

  constructor(private ws: WebSocket, readonly remoteAddr: string) {
    this.readerLoop = this.readLoop();
  }

  async openBidiStream(): Promise<BidiStream> {
    const id = this.nextStreamId;
    this.nextStreamId += 2;
    const stream = new WsGatewayBidiStream(id, this.ws);
    this.streams.set(id, stream);
    this.sendFrame(id, FRAME_OPEN, new Uint8Array(0));
    return stream;
  }

  async acceptBidiStream(): Promise<BidiStream> {
    throw new Error("Browser agents are client-only for v1");
  }

  async close(): Promise<void> {
    for (const s of this.streams.values()) s.abort(new Error("connection closed"));
    this.ws.close();
  }

  private async readLoop(): Promise<void> {
    while (this.ws.readyState === WebSocket.OPEN) {
      const buf = await onceMessage(this.ws);
      if (!buf) break;
      const { streamId, type, payload } = parseFrame(buf);
      const stream = this.streams.get(streamId);
      if (!stream) continue; // unknown stream, drop
      switch (type) {
        case FRAME_DATA: stream.onData(payload); break;
        case FRAME_FIN: stream.onFin(); break;
        case FRAME_RESET: stream.onReset(payload[0] ?? 0); break;
        case FRAME_PONG: /* keepalive response */ break;
      }
    }
  }

  sendFrame(streamId: number, type: number, payload: Uint8Array): void {
    const frame = new Uint8Array(9 + payload.length);
    const dv = new DataView(frame.buffer);
    dv.setUint32(0, streamId);
    frame[4] = type;
    dv.setUint32(5, payload.length);
    frame.set(payload, 9);
    if (this.ws.bufferedAmount > 1_048_576) {
      // backpressure: defer until drain (simplified — real impl awaits a drain event)
    }
    this.ws.send(frame);
  }
}

class WsGatewayBidiStream implements BidiStream {
  private incoming: Uint8Array[] = [];
  private waiters: Array<(v: Uint8Array | null) => void> = [];
  private ended = false;
  private aborted?: Error;

  constructor(private id: number, private ws: WebSocket) {}

  async write(data: Uint8Array): Promise<void> {
    this.sendFrame(FRAME_DATA, data);
  }
  async finish(): Promise<void> {
    this.sendFrame(FRAME_FIN, new Uint8Array(0));
  }
  async read(): Promise<Uint8Array | null> {
    if (this.incoming.length) return this.incoming.shift()!;
    if (this.ended) return null;
    if (this.aborted) throw this.aborted;
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  async reset(code = 0): Promise<void> {
    this.sendFrame(FRAME_RESET, new Uint8Array([code]));
  }

  // Called by the connection read loop:
  onData(data: Uint8Array): void {
    const w = this.waiters.shift();
    if (w) w(data);
    else this.incoming.push(data);
  }
  onFin(): void {
    this.ended = true;
    const w = this.waiters.shift();
    if (w) w(null);
  }
  onReset(code: number): void {
    this.aborted = new Error(`stream reset: code ${code}`);
    this.ended = true;
    const w = this.waiters.shift();
    if (w) w(null);
  }
  abort(err: Error): void {
    this.aborted = err;
    this.ended = true;
    const w = this.waiters.shift();
    if (w) w(null);
  }

  private sendFrame(type: number, payload: Uint8Array): void {
    // Delegate to the connection's sendFrame (in real impl, hold a back-ref).
    throw new Error("TODO: wire to WsGatewayConnection.sendFrame");
  }
}

function parseFrame(buf: ArrayBuffer): { streamId: number; type: number; payload: Uint8Array } {
  const view = new Uint8Array(buf);
  const dv = new DataView(buf);
  const streamId = dv.getUint32(0);
  const type = view[4];
  const len = dv.getUint32(5);
  const payload = view.slice(9, 9 + len);
  return { streamId, type, payload };
}

function once(ws: WebSocket, ev: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = () => { ws.removeEventListener(ev, ok); ws.removeEventListener("error", err); resolve(); };
    const err = () => { ws.removeEventListener(ev, ok); ws.removeEventListener("error", err); reject(new Error(`WebSocket ${ev} failed`)); };
    ws.addEventListener(ev, ok);
    ws.addEventListener("error", err);
  });
}

function onceMessage(ws: WebSocket): Promise<ArrayBuffer | null> {
  return new Promise((resolve) => {
    const onMsg = (ev: MessageEvent) => { ws.removeEventListener("message", onMsg); resolve(ev.data as ArrayBuffer); };
    const onClose = () => { ws.removeEventListener("message", onMsg); ws.removeEventListener("close", onClose); resolve(null); };
    ws.addEventListener("message", onMsg);
    ws.addEventListener("close", onClose);
  });
}
```

---

## 7. Isomorphic API

### 7.1 Principle

The same source file must run in Node.js, browsers, Deno, and Bun with no edits. The mechanism is:

1. **No Node-specific globals at the top level.** The SDK's public entry (`src/index.ts`) and all protocol-layer modules (`cbor.ts`, `framing.ts`, `handshake.ts`, `identity.ts`, `rpc.ts`) must not reference `process`, `Buffer`, `require`, `node:crypto`, `node:net`, or `node:quic` at module scope.
2. **Dynamic imports for Node-only code.** `src/transport/node-quic.ts` uses `await import("node:quic")` inside functions, never at the top level. Bundlers will split this into a separate chunk that is only loaded when the Node path is taken.
3. **Feature detection, not build flags.** The auto-detection factory (§8) checks `typeof process !== "undefined"`, `typeof WebTransport !== "undefined"`, etc. No `process.env.NODE_ENV` branching for transport selection.
4. **`Uint8Array` everywhere.** Never use `Buffer` in shared code. If a Node transport needs `Buffer`, convert at the boundary: `Buffer.from(uint8array)` and `new Uint8Array(buffer)` on the way back.
5. **WebCrypto as the crypto baseline.** Use `crypto.subtle` (available in Node 16+, all browsers, Deno, Bun) for hashes and random bytes. ML-DSA-65 uses `@noble/post-quantum` which is pure JS and needs no Node APIs.

### 7.2 Universal entry point

```typescript
// src/index.ts (isomorphic — runs in all runtimes)
export { Agent } from "./agent.js";
export { Request, Response, Params } from "./types.js";
export { HandlerError } from "./errors.js";
export type { BidiStream, Connection, Transport, TransportFactory } from "./transport/interface.js";

// Transport factories are exported but NOT imported at top level.
// Users import the one they want; the auto-detection factory lazy-loads them.
export { autoTransportFactory } from "./transport/auto.js";
```

### 7.3 Browser usage (client only)

```typescript
// The API is identical to Node — only the transport factory differs.
import { Agent, Request } from "@aafp/sdk";

const client = await Agent.connect()
  .withTransport(autoTransportFactory()) // picks WebTransport or WS gateway
  .connect();

const result = await client.discover("echo").call(Request.text("hello"));
console.log(result.body); // "hello"
```

---

## 8. Auto-Detection Transport Factory

Implement `src/transport/auto.ts`. This is the runtime feature-detection layer.

```typescript
// src/transport/auto.ts

import type { Transport, TransportFactory, TransportCreateOptions } from "./interface.js";

/**
 * Auto-detect the best available transport at runtime.
 * Order: node:quic → WebTransport → WebSocket gateway.
 * No build-time flags; pure feature detection.
 */
export function autoTransportFactory(gatewayUrl?: string): TransportFactory {
  return {
    async create(opts: TransportCreateOptions): Promise<Transport> {
      // 1. Node.js 25+ with node:quic
      if (typeof process !== "undefined" && hasNodeQuic()) {
        const { NodeQuicTransport } = await import("./node-quic.js");
        return new NodeQuicTransport(opts);
      }
      // 2. Browser / Deno with WebTransport
      if (typeof WebTransport !== "undefined") {
        const { WebTransportTransport } = await import("./webtransport.js");
        // Caller must supply the WebTransport URL via opts or a separate config.
        return WebTransportTransport.create(opts.webTransportUrl!, {});
      }
      // 3. WebSocket gateway fallback (Bun, old Node, restricted networks)
      const { WsGatewayTransport } = await import("./ws-gateway.js");
      const url = gatewayUrl ?? opts.gatewayUrl ?? defaultGatewayUrl();
      return WsGatewayTransport.create(url);
    },
  };
}

function hasNodeQuic(): boolean {
  try {
    // Use dynamic require — this code path only runs in Node.
    const quic = (globalThis as any).require?.("node:quic");
    return !!quic;
  } catch {
    return false;
  }
}

function defaultGatewayUrl(): string {
  if (typeof location !== "undefined") {
    // Browser: same origin, ws/wss based on page protocol.
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/aafp-gateway`;
  }
  return "ws://localhost:9000/aafp-gateway";
}
```

The dynamic `import()` calls are critical for bundle optimization (§10): bundlers split each transport into a separate chunk, and only the chunk for the runtime path actually used is ever loaded.

---

## 9. WebCrypto API for ML-DSA-65 (and WASM fallback)

### 9.1 Requirements

- Implement an `IdentityProvider` interface so the crypto backend is swappable.
- **Default provider:** `NobleIdentityProvider` — uses `@noble/post-quantum` `ml_dsa65` (pure JS, FIPS 204) for keygen/sign/verify, and `@noble/hashes` `sha256` for the agent ID fingerprint. This works in all runtimes with no Node APIs.
- **WebCrypto for hashes and randomness:** use `crypto.subtle.digest("SHA-256", data)` and `crypto.getRandomValues(bytes)` for non-ML-DSA operations. This avoids pulling `node:crypto` into the browser bundle.
- **WASM fallback hook:** define a `WasmIdentityProvider` interface slot so a future `@aafp/sdk-wasm` package (compiling `aafp-crypto` to WASM) can be injected for users who need native-equivalent ML-DSA-65 performance in the browser. The default provider remains pure-JS `@noble/post-quantum` for v1.
- **No `Buffer` in crypto code.** All operations take and return `Uint8Array`.
- **Cross-verification:** the ML-DSA-65 implementation must be verified against the Rust `aafp-crypto::dsa` test vectors (A-10). Same seed → same key → same deterministic signature. This is done in Phase 6 (cross-language interop); this phase only ensures the provider is swappable and WebCrypto-compatible.

### 9.2 Reference implementation

```typescript
// src/identity/webcrypto.ts

import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/post-quantum/utils.js";

export interface IdentityProvider {
  generateKeypair(seed?: Uint8Array): Promise<AgentKeypair>;
  sign(secretKey: Uint8Array, msg: Uint8Array): Uint8Array;
  verify(sig: Uint8Array, msg: Uint8Array, publicKey: Uint8Array): boolean;
  agentId(publicKey: Uint8Array): string; // hex of sha256(publicKey)
}

/**
 * Default identity provider. Uses @noble/post-quantum (pure JS, FIPS 204) for
 * ML-DSA-65 and @noble/hashes for SHA-256. Works in Node, browsers, Deno, Bun.
 * No Node-specific APIs.
 *
 * Performance: ML-DSA-65 sign/verify is ~10-50x slower than the Rust native
 * implementation. For handshake-heavy workloads, swap in a WASM provider
 * (WasmIdentityProvider) or use @aafp/sdk-native on Node.
 */
export class NobleIdentityProvider implements IdentityProvider {
  async generateKeypair(seed?: Uint8Array): Promise<AgentKeypair> {
    const keys = ml_dsa65.keygen(seed ?? this.randomBytes(32));
    return {
      publicKey: keys.publicKey,   // 1952 bytes
      secretKey: keys.secretKey,   // 4032 bytes
      agentId: () => this.agentId(keys.publicKey),
      sign: (msg: Uint8Array) => ml_dsa65.sign(msg, keys.secretKey),
    };
  }

  sign(secretKey: Uint8Array, msg: Uint8Array): Uint8Array {
    return ml_dsa65.sign(msg, secretKey);
  }

  verify(sig: Uint8Array, msg: Uint8Array, publicKey: Uint8Array): boolean {
    return ml_dsa65.verify(sig, msg, publicKey);
  }

  agentId(publicKey: Uint8Array): string {
    return toHex(sha256(publicKey));
  }

  /** Use WebCrypto random if available, fall back to noble's randomBytes. */
  private randomBytes(n: number): Uint8Array {
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      return crypto.getRandomValues(new Uint8Array(n));
    }
    return randomBytes(n);
  }
}

/**
 * Slot for a WASM-backed identity provider (future @aafp/sdk-wasm package).
 * The WASM module compiles aafp-crypto (Rust) to wasm32-wasi, giving
 * native-equivalent ML-DSA-65 performance in the browser. Not implemented in
 * Phase 6; the NobleIdentityProvider is the default.
 */
export interface WasmIdentityProvider extends IdentityProvider {
  // Identical interface; backed by WASM. Loaded via dynamic import:
  //   const { WasmIdentityProvider } = await import("@aafp/sdk-wasm");
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}
```

### 9.3 WebCrypto for SHA-256 (alternative path)

For code paths that only need SHA-256 (not ML-DSA), prefer `crypto.subtle` to avoid bundling `@noble/hashes` when the user already has WebCrypto:

```typescript
export async function sha256WebCrypto(data: Uint8Array): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(hash);
}
```

The identity provider should use whichever is available: `crypto.subtle` in browsers/Deno/Node 16+, `@noble/hashes` as a fallback.

---

## 10. Bundle Size Optimization

### 10.1 Goals

- **Client-only browser bundle** (no server code, no Node transport): target ≤ 60 KB gzipped including `@noble/post-quantum` ML-DSA-65.
- **Tree-shakeable:** importing only `{ Agent, Request }` must not pull in `ServeBuilder`, server-side handler dispatch, or `node:quic`.
- **Conditional imports:** each transport is a separate chunk loaded via dynamic `import()`, so a browser bundle never includes the `node:quic` code path.

### 10.2 package.json exports map

```json
{
  "name": "@aafp/sdk",
  "type": "module",
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "sideEffects": false,
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "browser": "./dist/index.browser.js",
      "default": "./dist/index.js"
    },
    "./transport/node-quic": "./dist/transport/node-quic.js",
    "./transport/webtransport": "./dist/transport/webtransport.js",
    "./transport/ws-gateway": "./dist/transport/ws-gateway.js",
    "./mcp": "./dist/mcp-transport.js",
    "./langchain": "./dist/langchain.js"
  },
  "files": ["dist"],
  "dependencies": {
    "@noble/post-quantum": "^1.0.0",
    "@noble/hashes": "^1.5.0"
  }
}
```

- `"sideEffects": false` tells bundlers the package is safe to tree-shake.
- The `"browser"` export condition points to a build that excludes the `node:quic` dynamic import entirely (some bundlers still bundle dynamic imports of Node builtins; the browser entry avoids this).
- Each transport is a separate subpath export so users can import only what they need.

### 10.3 Conditional import patterns

```typescript
// Good — dynamic import, tree-shakeable, separate chunk:
if (hasNodeQuic()) {
  const { NodeQuicTransport } = await import("./node-quic.js");
  return new NodeQuicTransport(opts);
}

// Bad — static import, pulls node:quic into every bundle:
import { NodeQuicTransport } from "./node-quic.js"; // NO
```

### 10.4 Pre-bundled CDN build

Publish a pre-bundled ESM build for direct browser usage (esm.sh, jsdelivr):

```html
<script type="module">
  import { Agent, Request, autoTransportFactory } from "https://esm.sh/@aafp/sdk";
  const client = await Agent.connect()
    .withTransport(autoTransportFactory("wss://relay.example.com/aafp-gateway"))
    .connect();
  const result = await client.discover("echo").call(Request.text("hello"));
</script>
```

The CDN build should use the WebSocket gateway by default (maximally compatible) and upgrade to WebTransport when available.

---

## 11. React / Vue / Svelte Integration Patterns

Provide reference adapters in `src/framework/` showing how to wrap `ConnectedAgent` for UI reactivity. These are patterns, not full packages (full adapters are Phase 8).

### 11.1 React hook

```typescript
// src/framework/react.ts

import { useEffect, useState, useCallback } from "react";
import { Agent, Request, ConnectedAgent } from "@aafp/sdk";
import { autoTransportFactory } from "@aafp/sdk";

export function useAafpClient(gatewayUrl?: string) {
  const [client, setClient] = useState<ConnectedAgent | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    Agent.connect()
      .withTransport(autoTransportFactory(gatewayUrl))
      .connect()
      .then((c) => { if (!cancelled) setClient(c); })
      .catch((e) => { if (!cancelled) setError(e); });
    return () => { cancelled = true; client?.close(); };
  }, [gatewayUrl]);

  const call = useCallback(async (capability: string, body: string) => {
    if (!client) throw new Error("Client not ready");
    return client.discover(capability).call(Request.text(body));
  }, [client]);

  return { client, error, call };
}

// Usage in a component:
function EchoComponent() {
  const { client, error, call } = useAafpClient("wss://relay.example.com/aafp-gateway");
  const [reply, setReply] = useState("");
  if (error) return <div>Error: {error.message}</div>;
  if (!client) return <div>Connecting…</div>;
  return (
    <button onClick={async () => setReply((await call("echo", "hello")).body)}>
      Echo → {reply}
    </button>
  );
}
```

### 11.2 Vue composable

```typescript
// src/framework/vue.ts

import { ref, onUnmounted } from "vue";
import { Agent, Request, type ConnectedAgent } from "@aafp/sdk";
import { autoTransportFactory } from "@aafp/sdk";

export function useAafpClient(gatewayUrl?: string) {
  const client = ref<ConnectedAgent | null>(null);
  const error = ref<Error | null>(null);

  Agent.connect()
    .withTransport(autoTransportFactory(gatewayUrl))
    .connect()
    .then((c) => { client.value = c; })
    .catch((e) => { error.value = e; });

  onUnmounted(() => client.value?.close());

  async function call(capability: string, body: string) {
    if (!client.value) throw new Error("Client not ready");
    return client.value.discover(capability).call(Request.text(body));
  }

  return { client, error, call };
}
```

### 11.3 Svelte store

```typescript
// src/framework/svelte.ts

import { writable } from "svelte/store";
import { Agent, Request, type ConnectedAgent } from "@aafp/sdk";
import { autoTransportFactory } from "@aafp/sdk";

export function createAafpClient(gatewayUrl?: string) {
  const client = writable<ConnectedAgent | null>(null);
  const error = writable<Error | null>(null);

  Agent.connect()
    .withTransport(autoTransportFactory(gatewayUrl))
    .connect()
    .then((c) => client.set(c))
    .catch((e) => error.set(e));

  async function call(capability: string, body: string) {
    let current: ConnectedAgent | null = null;
    const unsub = client.subscribe((c) => { current = c; });
    unsub();
    if (!current) throw new Error("Client not ready");
    return current.discover(capability).call(Request.text(body));
  }

  return { client, error, call };
}
```

---

## 12. Deno and Bun Compatibility

### 12.1 Deno

Deno supports WebTransport (via its HTTP/3 server) and has `Deno.connect` for raw UDP. The pure-TS SDK works in Deno with no changes because it uses WebCrypto (`crypto.subtle`) and WebTransport feature detection.

- **Distribution:** publish to JSR as `@aafp/sdk`. Deno users import via `import { Agent } from "jsr:@aafp/sdk";`.
- **No `npm:` specifiers needed** in the SDK source — `@noble/post-quantum` and `@noble/hashes` are pure JS and resolve via JSR's npm compatibility.
- **Smoke test:** `deno run --allow-net echo-client.ts` connects via WebTransport to a local AAFP server and performs an echo RPC.

```typescript
// examples/deno-echo-client.ts
import { Agent, Request } from "jsr:@aafp/sdk";
import { autoTransportFactory } from "jsr:@aafp/sdk";

const client = await Agent.connect()
  .withTransport(autoTransportFactory())
  .connect();
const result = await client.discover("echo").call(Request.text("hello from Deno"));
console.log(result.body);
```

### 12.2 Bun

Bun does not yet have native QUIC. The SDK falls back to the WebSocket gateway in Bun. As Bun matures QUIC support, a `BunQuicTransport` can be added. Bun supports `npm:` imports, so the npm package works as-is.

- **Smoke test:** `bun run echo-client.ts` connects via the WebSocket gateway and performs an echo RPC.
- **No special build step** — Bun runs the ESM TypeScript directly.

```typescript
// examples/bun-echo-client.ts
import { Agent, Request } from "@aafp/sdk";
import { autoTransportFactory } from "@aafp/sdk";

const client = await Agent.connect()
  .withTransport(autoTransportFactory("ws://localhost:9000/aafp-gateway"))
  .connect();
const result = await client.discover("echo").call(Request.text("hello from Bun"));
console.log(result.body);
```

### 12.3 Universal package principle

The SDK is written in ESM TypeScript with no Node-specific globals at the top level. Node-specific APIs (`node:quic`, `node:net`) are dynamically imported only in the Node transport. Browser APIs (`WebTransport`) are feature-detected. This makes the package "universal" — one source, three runtimes (Node, Deno, Bun) plus the browser.

---

## 13. Browser Echo Example

Provide `examples/browser-echo/index.html` and `examples/browser-echo/client.ts` — a client-only example that discovers an `echo` capability and calls it over WebTransport (with WS gateway fallback).

```html
<!-- examples/browser-echo/index.html -->
<!DOCTYPE html>
<html>
<head><title>AAFP Browser Echo</title></head>
<body>
  <input id="msg" value="hello" />
  <button id="call">Echo</button>
  <pre id="out"></pre>
  <script type="module">
    import { Agent, Request, autoTransportFactory } from "/dist/index.browser.js";

    const client = await Agent.connect()
      .withTransport(autoTransportFactory("wss://localhost:9000/aafp-gateway"))
      .connect();

    document.getElementById("call").onclick = async () => {
      const msg = document.getElementById("msg").value;
      const res = await client.discover("echo").call(Request.text(msg));
      document.getElementById("out").textContent = res.body;
    };
  </script>
</body>
</html>
```

The example must work when served over HTTPS (WebTransport requires secure context; `localhost` is exempt).

---

## 14. Testing Requirements

1. **WebTransport unit tests** — run in Chrome (headless via Playwright/Puppeteer) against a local `aafp gateway --webtransport`. Verify: open bidi stream, write, read, finish, reset.
2. **WebSocket gateway unit tests** — run in Node (using `ws` package) and in a headless browser. Verify: stream multiplexing, backpressure, keepalive, reset propagation.
3. **Isomorphic smoke test** — the same `echo-client.ts` runs in Node, Deno, Bun, and a headless Chrome, each calling the same AAFP server and asserting `result.body === "hello"`.
4. **Bundle size assertion** — esbuild bundles `import { Agent, Request } from "@aafp/sdk"` with the browser entry; assert gzipped output ≤ 60 KB.
5. **WebCrypto cross-verification** — run the A-10 ML-DSA-65 test vectors through `NobleIdentityProvider` and assert byte-identical signatures (same seed → same key → same sig). This overlaps with Phase 6 interop; include it here to guard against a WebCrypto-related regression.
6. **Deno smoke test** — `deno run --allow-net examples/deno-echo-client.ts` against a local server.
7. **Bun smoke test** — `bun run examples/bun-echo-client.ts` against a local WS gateway.

---

## 15. Acceptance Criteria

- [ ] `WebTransportTransport` passes all `BidiStream`/`Connection` conformance tests in headless Chrome.
- [ ] `WsGatewayTransport` passes the same conformance tests in Node and headless Chrome.
- [ ] `autoTransportFactory` selects the correct transport in Node 25+, a browser, Deno, and Bun without build flags.
- [ ] A single `echo-client.ts` runs unchanged in all four runtimes and completes an echo RPC.
- [ ] `NobleIdentityProvider` generates keys, signs, and verifies using only WebCrypto + `@noble/post-quantum` (no `node:crypto`).
- [ ] Browser bundle (client-only, gzipped) ≤ 60 KB.
- [ ] React hook, Vue composable, and Svelte store each drive an echo call in a minimal app.
- [ ] Deno smoke test passes via WebTransport.
- [ ] Bun smoke test passes via WebSocket gateway.
- [ ] No top-level reference to `process`, `Buffer`, `require`, `node:*`, or `__dirname` in any shared (non-transport) module.
- [ ] WebTransport PQ TLS trade-off (PQ identity + classical KEX) is documented in a comment on `WebTransportTransport` and in the browser quickstart.

---

## 16. Files to Create or Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/transport/webtransport.ts` | Create | WebTransport adapter |
| `src/transport/ws-gateway.ts` | Create | WebSocket-to-QUIC bridge client |
| `src/transport/auto.ts` | Modify | Add WebTransport + WS gateway branches to auto-detection |
| `src/identity/webcrypto.ts` | Create | `NobleIdentityProvider` + `WasmIdentityProvider` slot |
| `src/identity.ts` | Modify | Route through `IdentityProvider` interface instead of direct `@noble` calls |
| `src/framework/react.ts` | Create | `useAafpClient` hook |
| `src/framework/vue.ts` | Create | `useAafpClient` composable |
| `src/framework/svelte.ts` | Create | `createAafpClient` store |
| `src/index.ts` | Modify | Ensure no top-level Node globals; export browser entry |
| `package.json` | Modify | Add `exports` map, `"sideEffects": false`, browser entry |
| `examples/browser-echo/index.html` | Create | Browser echo demo |
| `examples/deno-echo-client.ts` | Create | Deno smoke test |
| `examples/bun-echo-client.ts` | Create | Bun smoke test |
| `tests/webtransport.test.ts` | Create | WebTransport conformance (Playwright) |
| `tests/ws-gateway.test.ts` | Create | WS gateway conformance |
| `tests/isomorphic.test.ts` | Create | Same-source, multi-runtime smoke test |
| `tests/bundle-size.test.ts` | Create | esbuild bundle size assertion |

---

## 17. Key Design Decisions to Respect

1. **Transport is selected at runtime, not build time.** No `process.env.BROWSER` checks. Feature detection only.
2. **Dynamic `import()` for every transport.** This is what makes tree-shaking and code-splitting work. Never statically import a transport module from shared code.
3. **`Uint8Array`, never `Buffer`, in shared code.** Convert at Node transport boundaries only.
4. **Browser agents are clients only for v1.** `Agent.serve()` throws in the browser. Serving requires a relay or server-side WebTransport endpoint (future work).
5. **The AAFP handshake is transport-agnostic.** It runs on stream 0 regardless of whether that stream is a QUIC bidi stream, a WebTransport bidi stream, or a logical stream over WebSocket. Do not special-case the handshake per transport.
6. **PQ identity is application-layer.** WebTransport's TLS may be classical KEX; the AAFP handshake's ML-DSA-65 signatures provide PQ identity regardless. Document this trade-off; do not attempt to force PQ TLS where the browser doesn't support it.
7. **The WebSocket gateway is a fallback, not the primary path.** It adds a relay hop and breaks the P2P property. Prefer WebTransport wherever available. The auto-detection order reflects this.
8. **`@noble/post-quantum` is the default crypto.** It is pure JS, FIPS 204, and works everywhere. The WASM provider is a future performance option, not a v1 requirement.
9. **One source, three runtimes plus browser.** Deno and Bun are not forks — they run the same ESM TypeScript. Only the transport selection differs, and that is runtime feature detection.

---

## 18. References

- `TYPESCRIPT_SDK_DESIGN.md` §6 — Transport Abstraction (the `Transport`/`Connection`/`BidiStream` interfaces)
- `TYPESCRIPT_SDK_DESIGN.md` §8 — Browser vs Node.js Strategy (transport split table, WebTransport considerations, browser agent API, WS gateway fallback)
- `TYPESCRIPT_SDK_DESIGN.md` §11 — Deno and Bun Support
- `TYPESCRIPT_SDK_DESIGN.md` §12 — Package Distribution (npm exports map, JSR, CDN)
- `TYPESCRIPT_SDK_DESIGN.md` §7.4 — Identity & handshake (ML-DSA-65, `AgentKeypair`)
- `TYPESCRIPT_SDK_DESIGN.md` §15 — Risk Analysis (WebTransport PQ TLS, browser serving)
- WebTransport browser support — https://caniuse.com/webtransport (Chrome 97+, Firefox 114+, Safari 26.4+)
- `@noble/post-quantum` — https://github.com/paulmillr/noble-post-quantum (ML-DSA-65, FIPS 204)
- RFC-0002 §5 — v1 handshake state machine (transport-agnostic)
- RFC-0003 — Identity & authentication (ML-DSA-65)
