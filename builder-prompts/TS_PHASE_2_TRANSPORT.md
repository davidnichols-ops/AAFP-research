# Builder Prompt: TypeScript SDK Phase 2 — Transport Abstraction

**Target:** `@aafp/sdk` TypeScript package
**Phase:** 2 of N (Transport Abstraction)
**Prerequisites:** Phase 1 (project scaffold, CBOR encoder/decoder, `Params`/`Request`/`Response` types) complete.
**Reference implementations:**
- Rust: `implementations/rust/crates/aafp-transport-quic/src/` (quinn + rustls)
- Rust: `implementations/rust/crates/aafp-messaging/src/framing.rs` (frame codec)
- Design: `TYPESCRIPT_SDK_DESIGN.md` §6 (Transport Abstraction), §7.2 (Frame encoding)

---

## Objective

Implement the transport abstraction layer for the AAFP TypeScript SDK. This
phase delivers:

1. **Transport interfaces** (`Transport`, `Connection`, `BidiStream`,
   `UniStream`) in TypeScript — the contract that decouples AAFP
   handshake/framing/RPC from the underlying byte-stream mechanism.
2. **Node.js QUIC transport** via `node:quic` (Node 25+, experimental) with
   an msquic-bindings fallback for Node LTS.
3. **Browser WebTransport transport** (HTTP/3) adapter.
4. **WebSocket fallback transport** for environments without QUIC.
5. **AAFP frame encoding/decoding** in TypeScript, byte-for-byte compatible
   with `aafp-messaging::framing` (RFC-0002 §3, Rev 6).
6. **ALPN negotiation** (`aafp/1`) enforced on every transport.
7. **Connection configuration** (timeouts, flow control, stream limits).
8. **Unit tests** for frame round-trip and transport interface conformance.

The transport layer is transport-agnostic: the AAFP handshake, framing, and
RPC layers operate on `BidiStream` / `UniStream` byte streams, never on
sockets directly. This is the same architectural seam as the Rust
`QuicConnection` / `QuicSendStream` / `QuicRecvStream` types.

---

## File Layout

```
src/transport/
  interface.ts          # Transport, Connection, BidiStream, UniStream, config
  config.ts             # TransportConfig, presets, ALPN constant
  frame.ts              # AAFP frame encode/decode (RFC-0002 §3)
  node-quic.ts          # NodeQuicTransport (node:quic, Node 25+)
  webtransport.ts       # WebTransportTransport (browser HTTP/3)
  ws-gateway.ts         # WsGatewayTransport (WebSocket fallback)
  auto.ts               # defaultTransportFactory (auto-detect)
  in-memory.ts          # InMemoryTransport (test harness, loopback)
  stream-utils.ts       # BidiStreamAdapter helpers, chunked readers
test/transport/
  frame.test.ts         # frame round-trip, edge cases, golden vectors
  interface.test.ts     # transport conformance suite (runs against all impls)
  in-memory.test.ts     # loopback connection + stream tests
  config.test.ts        # config presets, ALPN constant
```

---

## 1. Transport Interfaces (`src/transport/interface.ts`)

Define the core abstractions. These mirror the Rust `QuicTransport`,
`QuicConnection`, `QuicSendStream`, `QuicRecvStream` types but are
runtime-agnostic. The key insight from the Rust implementation: the AAFP
framing layer only needs **byte streams** — it never touches sockets.

### 1.1 BidiStream

A bidirectional byte stream. Maps to a QUIC bidi stream, a WebTransport
bidirectional stream, or a virtual stream over WebSocket.

```typescript
// src/transport/interface.ts

/**
 * A bidirectional byte stream — the fundamental unit the AAFP framing
 * layer operates on. Maps to a QUIC bidi stream or a WebTransport bidi stream.
 *
 * Lifecycle:
 *   1. write() / read() — exchange bytes
 *   2. finish() — half-close the send side (send FIN)
 *   3. read() returns null when the remote side finishes
 *   4. reset() — abort the stream with an error code
 */
export interface BidiStream {
  /** Write bytes to the stream. Resolves when the data is buffered. */
  write(data: Uint8Array): Promise<void>;
  /** Signal that the send side is finished (half-close, sends FIN). */
  finish(): Promise<void>;
  /**
   * Read the next chunk of bytes. Returns null when the stream has ended
   * (remote FIN received). Throws on stream reset.
   */
  read(): Promise<Uint8Array | null>;
  /** Abort the stream with an error code (QUIC STOP_SENDING / RST_STREAM). */
  reset(code?: number): Promise<void>;
  /** The stream ID (for logging and multiplexing). */
  readonly id: bigint;
}
```

### 1.2 UniStream

A unidirectional byte stream (send-only or receive-only). Used for
handshake frames and one-way notifications.

```typescript
/**
 * A unidirectional send stream. Maps to a QUIC uni stream (send side).
 */
export interface UniSendStream {
  write(data: Uint8Array): Promise<void>;
  finish(): Promise<void>;
  reset(code?: number): Promise<void>;
  readonly id: bigint;
}

/**
 * A unidirectional receive stream. Maps to a QUIC uni stream (recv side).
 */
export interface UniRecvStream {
  read(): Promise<Uint8Array | null>;
  stop(code?: number): Promise<void>;
  readonly id: bigint;
}
```

### 1.3 Connection

A connection to a peer, providing bidirectional and unidirectional streams.
Maps to a QUIC connection or a WebTransport session.

```typescript
/**
 * A connection to a peer, providing bidirectional streams.
 * Maps to a QUIC connection or a WebTransport session.
 */
export interface Connection {
  /** Open a new bidirectional stream. */
  openBidiStream(): Promise<BidiStream>;
  /** Open a new unidirectional stream (send side). */
  openUniStream(): Promise<UniSendStream>;
  /** Accept an incoming bidirectional stream (server side). */
  acceptBidiStream(): Promise<BidiStream>;
  /** Accept an incoming unidirectional stream (server side). */
  acceptUniStream(): Promise<UniRecvStream>;
  /** Close the connection with an optional error code and reason. */
  close(code?: number, reason?: string): Promise<void>;
  /**
   * Export TLS channel binding material (RFC 5705). Used by the AAFP
   * handshake to bind the application-layer identity to the TLS session.
   * Returns a 32-byte binding. Throws if the transport does not support
   * TLS export (e.g., WebSocket fallback returns a synthetic binding).
   */
  exportTlsBinding(label: string, context?: Uint8Array): Promise<Uint8Array>;
  /** The peer's address (for logging and routing). */
  readonly remoteAddr: string;
  /** Whether the negotiated ALPN is `aafp/1`. */
  readonly alpnNegotiated: boolean;
}
```

### 1.4 Transport

Factory that creates transport connections (client) or accepts them (server).

```typescript
/**
 * Factory that creates transport connections (client) or accepts them (server).
 * Maps to a QUIC endpoint or a WebTransport listener.
 */
export interface Transport {
  /** Dial a peer at the given multiaddr (e.g., "quic://1.2.3.4:4433"). */
  dial(addr: Multiaddr): Promise<Connection>;
  /** Accept an incoming connection (server side). */
  accept(): Promise<Connection>;
  /** The local address this transport is bound to. */
  readonly localAddr: Multiaddr;
  /** Close the transport and all associated connections. */
  close(): Promise<void>;
}

export interface TransportFactory {
  create(opts: TransportCreateOptions): Promise<Transport>;
}

export interface TransportCreateOptions {
  role: "client" | "server";
  bindAddr?: string;
  config?: TransportConfig;
}
```

---

## 2. Connection Configuration (`src/transport/config.ts`)

Mirror the Rust `QuicConfig` (see `aafp-transport-quic/src/config.rs`). The
TS config is transport-agnostic — each concrete transport maps it to its
native settings.

```typescript
// src/transport/config.ts

/** ALPN protocol identifier for AAFP v1 (RFC-0002 §2.2, RFC-0006 §2.3). */
export const AAFP_ALPN = "aafp/1";

/** Congestion controller type (Track J1). */
export enum CongestionController {
  Cubic = "cubic",
  Bbr = "bbr",
}

/**
 * Transport configuration. Maps to `QuicConfig` in the Rust implementation.
 * Each concrete transport applies these settings to its native API.
 */
export interface TransportConfig {
  /** Address to bind the transport (server). Default: "127.0.0.1:0". */
  bindAddr: string;
  /** Maximum concurrent streams per connection. Default: 100. */
  maxConcurrentStreams: number;
  /** Keep-alive interval in milliseconds. Default: 30000 (30s). */
  keepAliveIntervalMs: number;
  /** Maximum idle timeout in milliseconds. Default: 30000 (30s). */
  maxIdleTimeoutMs: number;
  /** Initial RTT estimate in milliseconds. Default: 10. */
  initialRttMs: number;
  /** Maximum ACK delay in milliseconds. Default: 5. */
  maxAckDelayMs: number;
  /** Stream initial max data (flow control window) in bytes. Default: 1MB. */
  streamInitialMaxData: number;
  /** Maximum payload size per frame (RFC-0002 §3.4). Default: 1MB. */
  maxPayloadSize: number;
  /** Maximum extension section size. Default: 64KB. */
  maxExtensionSize: number;
  /** Congestion controller. Default: Cubic. */
  congestion: CongestionController;
  /** Enable post-quantum KEX (X25519MLKEM768). Default: true. */
  enablePqKex: boolean;
}

export const DEFAULT_CONFIG: TransportConfig = {
  bindAddr: "127.0.0.1:0",
  maxConcurrentStreams: 100,
  keepAliveIntervalMs: 30_000,
  maxIdleTimeoutMs: 30_000,
  initialRttMs: 10,
  maxAckDelayMs: 5,
  streamInitialMaxData: 1024 * 1024,
  maxPayloadSize: 1024 * 1024,
  maxExtensionSize: 64 * 1024,
  congestion: CongestionController.Cubic,
  enablePqKex: true,
};

/**
 * Low-latency preset for agent-to-agent RPC (Track J1-J4).
 * BBR congestion control, 10ms RTT, 5ms ACK, 1MB window.
 */
export function lowLatencyConfig(): TransportConfig {
  return { ...DEFAULT_CONFIG, congestion: CongestionController.Bbr };
}

/**
 * Bulk transfer preset for large payloads.
 * Cubic congestion, 100ms RTT, 25ms ACK, 10MB window.
 */
export function bulkTransferConfig(): TransportConfig {
  return {
    ...DEFAULT_CONFIG,
    congestion: CongestionController.Cubic,
    initialRttMs: 100,
    maxAckDelayMs: 25,
    streamInitialMaxData: 10 * 1024 * 1024,
    maxIdleTimeoutMs: 300_000,
  };
}
```

---

## 3. AAFP Frame Encoding (`src/transport/frame.ts`)

Implement the AAFP v1 frame codec (RFC-0002 §3, Rev 6). This MUST be
byte-for-byte compatible with `aafp-messaging::framing::encode_frame` /
`decode_frame`. The wire format is:

```
[28-byte header][extensions][payload]

Header (all big-endian):
  Version:       1 byte   (AAFP protocol version, 1 for v1)
  FrameType:     1 byte   (frame type, see §4)
  Flags:         1 byte   (frame-specific flags)
  Reserved:      1 byte   (MUST be 0, MUST be ignored by receivers)
  Stream ID:     8 bytes  (stream this frame belongs to)
  Payload Len:   8 bytes  (length of payload section)
  Extension Len: 8 bytes  (length of extension section)
```

```typescript
// src/transport/frame.ts

export const AAFP_VERSION = 1;
export const MAX_PAYLOAD_SIZE = 1024 * 1024; // 1 MiB (RFC-0002 §3.4)
export const MAX_EXTENSION_SIZE = 64 * 1024; // 64 KiB (SA-0006)
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

export const FrameFlags = {
  MORE: 0x01,
  COMPRESSED: 0x02,
  CRITICAL: 0x80,
} as const;

export interface Frame {
  version: number;
  type: FrameType;
  flags: number;
  streamId: bigint;
  payload: Uint8Array;
  extensions: Uint8Array;
}

export class FrameError extends Error {
  constructor(
    public readonly kind:
      | "PayloadTooLarge"
      | "ExtensionTooLarge"
      | "Incomplete"
      | "UnknownFrameType"
      | "InvalidVersion",
    message: string,
    public readonly needed?: number,
    public readonly have?: number,
  ) {
    super(message);
    this.name = "FrameError";
  }
}

/** Convert a raw byte to a FrameType (Unknown types preserved for logging). */
export function frameTypeFromU8(val: number): FrameType {
  switch (val) {
    case 0x01: return FrameType.Data;
    case 0x02: return FrameType.Handshake;
    case 0x03: return FrameType.RpcRequest;
    case 0x04: return FrameType.RpcResponse;
    case 0x05: return FrameType.Close;
    case 0x06: return FrameType.Error;
    case 0x07: return FrameType.Ping;
    case 0x08: return FrameType.Pong;
    default: return val as FrameType; // unknown — caller checks critical bit
  }
}

/** Encode a frame to bytes: [28-byte header][extensions][payload]. */
export function encodeFrame(frame: Frame): Uint8Array {
  if (frame.payload.length > MAX_PAYLOAD_SIZE) {
    throw new FrameError(
      "PayloadTooLarge",
      `payload ${frame.payload.length} bytes (max ${MAX_PAYLOAD_SIZE})`,
    );
  }
  if (frame.extensions.length > MAX_EXTENSION_SIZE) {
    throw new FrameError(
      "ExtensionTooLarge",
      `extensions ${frame.extensions.length} bytes (max ${MAX_EXTENSION_SIZE})`,
    );
  }

  const total = FRAME_HEADER_SIZE + frame.extensions.length + frame.payload.length;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);

  // Header (28 bytes, big-endian)
  view.setUint8(0, AAFP_VERSION);
  view.setUint8(1, frame.type);
  view.setUint8(2, frame.flags);
  view.setUint8(3, 0); // reserved, MUST be 0
  view.setBigUint64(4, frame.streamId);
  view.setBigUint64(12, BigInt(frame.payload.length));
  view.setBigUint64(20, BigInt(frame.extensions.length));

  // Body: extensions first, then payload (RFC-0002 §3.2)
  u8.set(frame.extensions, FRAME_HEADER_SIZE);
  u8.set(frame.payload, FRAME_HEADER_SIZE + frame.extensions.length);

  return u8;
}

/**
 * Decode a frame from bytes. Returns { frame, consumed }.
 * Throws FrameError on incomplete data, invalid version, or oversized sections.
 */
export function decodeFrame(data: Uint8Array): { frame: Frame; consumed: number } {
  if (data.length < FRAME_HEADER_SIZE) {
    throw new FrameError(
      "Incomplete",
      `need ${FRAME_HEADER_SIZE} bytes, have ${data.length}`,
      FRAME_HEADER_SIZE,
      data.length,
    );
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const version = view.getUint8(0);
  const frameTypeRaw = view.getUint8(1);
  const flags = view.getUint8(2);
  // data[3] is reserved — ignored per RFC-0002 §3.1
  const streamId = view.getBigUint64(4);
  const payloadLen = Number(view.getBigUint64(12));
  const extLen = Number(view.getBigUint64(20));

  if (version !== AAFP_VERSION) {
    throw new FrameError(
      "InvalidVersion",
      `version ${version} (expected ${AAFP_VERSION})`,
    );
  }
  if (payloadLen > MAX_PAYLOAD_SIZE) {
    throw new FrameError("PayloadTooLarge", `payload ${payloadLen} (max ${MAX_PAYLOAD_SIZE})`);
  }
  if (extLen > MAX_EXTENSION_SIZE) {
    throw new FrameError("ExtensionTooLarge", `extensions ${extLen} (max ${MAX_EXTENSION_SIZE})`);
  }

  const totalFrame = FRAME_HEADER_SIZE + extLen + payloadLen;
  if (data.length < totalFrame) {
    throw new FrameError(
      "Incomplete",
      `need ${totalFrame} bytes, have ${data.length}`,
      totalFrame,
      data.length,
    );
  }

  // Per RFC-0006 §4.2: unknown + critical bit → reject; unknown + non-critical → skip
  const knownTypes = new Set([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
  if (!knownTypes.has(frameTypeRaw) && (flags & FrameFlags.CRITICAL) !== 0) {
    throw new FrameError("UnknownFrameType", `0x${frameTypeRaw.toString(16).padStart(2, "0")}`);
  }

  const frameType = frameTypeFromU8(frameTypeRaw);
  const extensions = data.slice(FRAME_HEADER_SIZE, FRAME_HEADER_SIZE + extLen);
  const payload = data.slice(FRAME_HEADER_SIZE + extLen, totalFrame);

  return {
    frame: { version, type: frameType, flags, streamId, payload, extensions },
    consumed: totalFrame,
  };
}

// ─── Frame constructors (matching Rust Frame::data, Frame::handshake, etc.) ──

export function dataFrame(streamId: bigint, payload: Uint8Array): Frame {
  return { version: AAFP_VERSION, type: FrameType.Data, flags: 0, streamId, payload, extensions: new Uint8Array(0) };
}

export function handshakeFrame(payload: Uint8Array): Frame {
  return { version: AAFP_VERSION, type: FrameType.Handshake, flags: 0, streamId: 0n, payload, extensions: new Uint8Array(0) };
}

export function pingFrame(streamId: bigint): Frame {
  return { version: AAFP_VERSION, type: FrameType.Ping, flags: 0, streamId, payload: new Uint8Array(0), extensions: new Uint8Array(0) };
}

export function pongFrame(streamId: bigint): Frame {
  return { version: AAFP_VERSION, type: FrameType.Pong, flags: 0, streamId, payload: new Uint8Array(0), extensions: new Uint8Array(0) };
}

/** Set the MORE flag (for DATA frame fragmentation). */
export function withMore(frame: Frame): Frame {
  return { ...frame, flags: frame.flags | FrameFlags.MORE };
}

/** Check if the MORE flag is set. */
export function hasMore(frame: Frame): boolean {
  return (frame.flags & FrameFlags.MORE) !== 0;
}

/** Total wire size of a frame (header + extensions + payload). */
export function wireSize(frame: Frame): number {
  return FRAME_HEADER_SIZE + frame.extensions.length + frame.payload.length;
}
```

---

## 4. Node.js QUIC Transport (`src/transport/node-quic.ts`)

Wrap `node:quic` (Node 25+, behind `--experimental-quic`) to implement the
`Transport` interface. This is the primary transport for Node.js backends.

**Key mapping:**
- `QuicEndpoint` → `NodeQuicTransport`
- `QuicConnection` → `Connection`
- `QuicBidiStream` → `BidiStream`
- `QuicUniStream` → `UniSendStream` / `UniRecvStream`

**ALPN:** The endpoint MUST be configured with `alpn: ["aafp/1"]`. After
connection, verify `connection.alpnProtocol === "aafp/1"`; if not, close
with error (RFC-0002 §2.2).

**TLS identity:** Generate a self-signed Ed25519 certificate via Node's
`crypto` module (analogous to `generate_self_signed_cert()` in Rust). The
TLS layer uses TOFU (trust-on-first-use); agent identity is verified at the
application layer via the AAFP handshake.

```typescript
// src/transport/node-quic.ts

import type { Transport, Connection, BidiStream, UniSendStream, UniRecvStream } from "./interface.js";
import type { TransportConfig } from "./config.js";
import { AAFP_ALPN } from "./config.js";

/**
 * Node.js QUIC transport via node:quic (Node 25+, --experimental-quic).
 *
 * For Node LTS (22/24) without node:quic, users should install
 * @aafp/sdk-native (napi-rs addon) or use the WebSocket gateway fallback.
 */
export class NodeQuicTransport implements Transport {
  private endpoint: any; // QuicEndpoint — typed as any for conditional import
  private readonly config: TransportConfig;
  private readonly localAddress: string;

  private constructor(endpoint: any, config: TransportConfig, localAddr: string) {
    this.endpoint = endpoint;
    this.config = config;
    this.localAddress = localAddr;
  }

  static async create(config: TransportConfig): Promise<NodeQuicTransport> {
    // Dynamic import so the module loads even on Node < 25 (fails at call time).
    const { QuicEndpoint } = await import("node:quic");
    const { generateSelfSignedCert } = await import("./node-cert.js");

    const identity = await generateSelfSignedCert();

    const endpoint = new QuicEndpoint({
      alpn: [AAFP_ALPN],
      server: {
        key: identity.privateKey,
        cert: identity.certificate,
      },
      // Transport config mapping:
      maxConcurrentBidiStreams: config.maxConcurrentStreams,
      maxConcurrentUniStreams: config.maxConcurrentStreams,
      maxIdleTimeout: config.maxIdleTimeoutMs,
      keepAliveInterval: config.keepAliveIntervalMs,
      initialMaxData: config.streamInitialMaxData,
      // PQ KEX: node:quic supports X25519MLKEM768 when enablePqKex is true.
      // The TLS layer negotiates it automatically if both sides support it.
    });

    const addr = endpoint.address();
    const localAddr = `quic://${addr.address}:${addr.port}`;
    return new NodeQuicTransport(endpoint, config, localAddr);
  }

  get localAddr(): string {
    return this.localAddress;
  }

  async dial(addr: string): Promise<Connection> {
    const socketAddr = parseMultiaddr(addr);
    const conn = await this.endpoint.connect({
      address: socketAddr.host,
      port: socketAddr.port,
      alpn: AAFP_ALPN,
    });

    // Verify ALPN negotiation (RFC-0002 §2.2).
    if (conn.alpnProtocol !== AAFP_ALPN) {
      await conn.close(0, "ALPN negotiation failed");
      throw new Error(`ALPN negotiation failed: expected ${AAFP_ALPN}, got ${conn.alpnProtocol}`);
    }

    return new NodeQuicConnection(conn);
  }

  async accept(): Promise<Connection> {
    const conn = await this.endpoint.accept();
    if (conn.alpnProtocol !== AAFP_ALPN) {
      await conn.close(0, "ALPN negotiation failed");
      throw new Error(`ALPN negotiation failed: expected ${AAFP_ALPN}, got ${conn.alpnProtocol}`);
    }
    return new NodeQuicConnection(conn);
  }

  async close(): Promise<void> {
    await this.endpoint.close();
  }
}

class NodeQuicConnection implements Connection {
  constructor(private conn: any) {}

  get remoteAddr(): string {
    const r = this.conn.remoteAddress;
    return `quic://${r.address}:${r.port}`;
  }

  get alpnNegotiated(): boolean {
    return this.conn.alpnProtocol === AAFP_ALPN;
  }

  async openBidiStream(): Promise<BidiStream> {
    const stream = await this.conn.createBidiStream();
    return new NodeQuicBidiStream(stream);
  }

  async openUniStream(): Promise<UniSendStream> {
    const stream = await this.conn.createUniStream();
    return new NodeQuicUniSendStream(stream);
  }

  async acceptBidiStream(): Promise<BidiStream> {
    const stream = await this.conn.acceptBidiStream();
    return new NodeQuicBidiStream(stream);
  }

  async acceptUniStream(): Promise<UniRecvStream> {
    const stream = await this.conn.acceptUniStream();
    return new NodeQuicUniRecvStream(stream);
  }

  async close(code = 0, reason?: string): Promise<void> {
    await this.conn.close(code, reason ?? "");
  }

  async exportTlsBinding(label: string, context?: Uint8Array): Promise<Uint8Array> {
    // node:quic exposes exportKeyingMaterial on the connection.
    return this.conn.exportKeyingMaterial(label, context ?? new Uint8Array(0), 32);
  }
}

class NodeQuicBidiStream implements BidiStream {
  constructor(private stream: any) {}
  get id(): bigint { return BigInt(this.stream.id); }
  async write(data: Uint8Array): Promise<void> { await this.stream.writable.write(data); }
  async finish(): Promise<void> { await this.stream.writable.close(); }
  async read(): Promise<Uint8Array | null> {
    const result = await this.stream.readable.read();
    return result.done ? null : result.value;
  }
  async reset(code = 0): Promise<void> {
    this.stream.writable.abort(code);
    this.stream.readable.cancel(code);
  }
}

class NodeQuicUniSendStream implements UniSendStream {
  constructor(private stream: any) {}
  get id(): bigint { return BigInt(this.stream.id); }
  async write(data: Uint8Array): Promise<void> { await this.stream.writable.write(data); }
  async finish(): Promise<void> { await this.stream.writable.close(); }
  async reset(code = 0): Promise<void> { this.stream.writable.abort(code); }
}

class NodeQuicUniRecvStream implements UniRecvStream {
  constructor(private stream: any) {}
  get id(): bigint { return BigInt(this.stream.id); }
  async read(): Promise<Uint8Array | null> {
    const result = await this.stream.readable.read();
    return result.done ? null : result.value;
  }
  async stop(code = 0): Promise<void> { this.stream.readable.cancel(code); }
}

function parseMultiaddr(addr: string): { host: string; port: number } {
  const m = addr.match(/^quic:\/\/(.+):(\d+)$/);
  if (!m) throw new Error(`invalid multiaddr: ${addr}`);
  return { host: m[1], port: parseInt(m[2], 10) };
}
```

### 4.1 msquic fallback for Node LTS

For Node.js LTS (22/24) where `node:quic` is unavailable, provide an
optional adapter using a native msquic binding (`@aafp/msquic` or
`@msquic/node`). The adapter implements the same `Transport` interface.
This is loaded lazily — only when `node:quic` import fails:

```typescript
// src/transport/msquic-fallback.ts (optional, lazy-loaded)

export async function createMsquicTransport(config: TransportConfig): Promise<Transport> {
  // Dynamic import of the native msquic binding.
  // This package is an optional peer dependency.
  const { MsquicEndpoint } = await import("@aafp/msquic");
  // ... wrap in the same Transport/Connection/BidiStream interfaces
  // The ALPN, TLS identity, and config mapping are identical to NodeQuicTransport.
}
```

---

## 5. Browser WebTransport (`src/transport/webtransport.ts`)

Wrap the browser `WebTransport` API (HTTP/3) to implement the `Transport`
interface. This is the primary transport for browser-based agents.

**Key differences from QUIC:**
- WebTransport is HTTP/3, not raw QUIC — the ALPN is `h3`, not `aafp/1`.
  The AAFP handshake still runs on stream 0 to negotiate the AAFP protocol
  version and verify agent identity.
- `WebTransportBidirectionalStream` → `BidiStream`
- `WebTransportSendStream` / `WebTransportReceiveStream` → `UniSendStream` / `UniRecvStream`
- No `exportTlsBinding` — WebTransport does not expose the TLS exporter.
  Return a synthetic binding derived from the session ID (the AAFP handshake
  must account for this in its channel-binding logic).

```typescript
// src/transport/webtransport.ts

import type { Transport, Connection, BidiStream, UniSendStream, UniRecvStream } from "./interface.js";
import type { TransportConfig } from "./config.js";

/**
 * Browser WebTransport transport (HTTP/3).
 *
 * Note: WebTransport is HTTP/3, so the ALPN is "h3" (negotiated by the
 * browser). The AAFP protocol version is negotiated at the application
 * layer via the AAFP handshake on stream 0.
 */
export class WebTransportTransport implements Transport {
  private server: any; // WebTransportServer (if available in runtime)
  private readonly config: TransportConfig;
  private readonly localAddress: string;

  private constructor(server: any, config: TransportConfig, localAddr: string) {
    this.server = server;
    this.config = config;
    this.localAddress = localAddr;
  }

  /**
   * Create a server-side WebTransport transport.
   * In browsers, this is typically not available — use createClient() instead.
   * In Deno/Bun, WebTransportServer may be available.
   */
  static async createServer(config: TransportConfig): Promise<WebTransportTransport> {
    // Deno exposes WebTransportServer; browsers do not.
    const { WebTransportServer } = await import("node:webtransport" as any).catch(() => ({} as any));
    if (!WebTransportServer) {
      throw new Error("WebTransportServer not available in this runtime");
    }
    const server = new WebTransportServer(config.bindAddr);
    await server.ready;
    return new WebTransportTransport(server, config, `webtransport://${config.bindAddr}`);
  }

  get localAddr(): string {
    return this.localAddress;
  }

  async dial(url: string): Promise<Connection> {
    // Browser WebTransport client — url is an https:// URL.
    const wt = new WebTransport(url, {
      // Flow control and congestion settings are managed by the browser.
      // The serverConstraint option can hint at desired limits.
    });
    await wt.ready;
    return new WebTransportConnection(wt, url);
  }

  async accept(): Promise<Connection> {
    const session = await this.server.accept();
    return new WebTransportConnection(session, this.localAddress);
  }

  async close(): Promise<void> {
    await this.server?.close();
  }
}

class WebTransportConnection implements Connection {
  constructor(private wt: any, private remote: string) {}

  get remoteAddr(): string { return this.remote; }
  get alpnNegotiated(): boolean {
    // WebTransport is HTTP/3; AAFP ALPN is negotiated at app layer.
    // Return true — the handshake will verify the protocol version.
    return true;
  }

  async openBidiStream(): Promise<BidiStream> {
    const stream = await this.wt.createBidirectionalStream();
    return new WebTransportBidiStream(stream);
  }

  async openUniStream(): Promise<UniSendStream> {
    const stream = await this.wt.createUnidirectionalStream();
    return new WebTransportUniSendStream(stream);
  }

  async acceptBidiStream(): Promise<BidiStream> {
    const reader = this.wt.incomingBidirectionalStreams.getReader();
    const { value, done } = await reader.read();
    reader.releaseLock();
    if (done) throw new Error("no incoming bidi stream");
    return new WebTransportBidiStream(value);
  }

  async acceptUniStream(): Promise<UniRecvStream> {
    const reader = this.wt.incomingUnidirectionalStreams.getReader();
    const { value, done } = await reader.read();
    reader.releaseLock();
    if (done) throw new Error("no incoming uni stream");
    return new WebTransportUniRecvStream(value);
  }

  async close(code = 0, reason?: string): Promise<void> {
    this.wt.close({ closeCode: code, reason: new TextEncoder().encode(reason ?? "") });
  }

  async exportTlsBinding(_label: string, _context?: Uint8Array): Promise<Uint8Array> {
    // WebTransport does not expose the TLS exporter.
    // Return a synthetic 32-byte binding from the session's datagram hash.
    // The AAFP handshake MUST account for this (it cannot rely on TLS
    // channel binding for WebTransport connections — use the handshake
    // transcript hash instead).
    const hash = new Uint8Array(32);
    crypto.getRandomValues(hash); // placeholder — real impl uses session ID
    return hash;
  }
}

class WebTransportBidiStream implements BidiStream {
  private static nextId = 0n;
  readonly id: bigint;

  constructor(private stream: any) {
    this.id = BigInt(WebTransportBidiStream.nextId++);
  }

  async write(data: Uint8Array): Promise<void> {
    const writer = this.stream.writable.getWriter();
    await writer.write(data);
    writer.releaseLock();
  }

  async finish(): Promise<void> {
    const writer = this.stream.writable.getWriter();
    await writer.close();
    writer.releaseLock();
  }

  async read(): Promise<Uint8Array | null> {
    const reader = this.stream.readable.getReader();
    const { value, done } = await reader.read();
    reader.releaseLock();
    return done ? null : value;
  }

  async reset(code = 0): Promise<void> {
    this.stream.writable.abort(code);
    this.stream.readable.cancel(code);
  }
}

class WebTransportUniSendStream implements UniSendStream {
  private static nextId = 0n;
  readonly id: bigint;

  constructor(private stream: any) {
    this.id = BigInt(WebTransportUniSendStream.nextId++);
  }

  async write(data: Uint8Array): Promise<void> {
    const writer = this.stream.getWriter();
    await writer.write(data);
    writer.releaseLock();
  }

  async finish(): Promise<void> {
    const writer = this.stream.getWriter();
    await writer.close();
    writer.releaseLock();
  }

  async reset(code = 0): Promise<void> {
    this.stream.abort(code);
  }
}

class WebTransportUniRecvStream implements UniRecvStream {
  private static nextId = 0n;
  readonly id: bigint;

  constructor(private stream: any) {
    this.id = BigInt(WebTransportUniRecvStream.nextId++);
  }

  async read(): Promise<Uint8Array | null> {
    const reader = this.stream.getReader();
    const { value, done } = await reader.read();
    reader.releaseLock();
    return done ? null : value;
  }

  async stop(code = 0): Promise<void> {
    this.stream.cancel(code);
  }
}
```

---

## 6. WebSocket Fallback (`src/transport/ws-gateway.ts`)

For environments without QUIC or WebTransport (older browsers, restricted
networks), fall back to a WebSocket connection to an AAFP relay gateway.
The gateway (`aafp gateway --ws`) translates WebSocket frames to QUIC
streams on the server side.

**Stream multiplexing over WebSocket:** Each AAFP stream is multiplexed over
a single WebSocket connection using a simple framing protocol:
```
[1 byte: stream op][8 bytes: stream ID][4 bytes: payload length][payload]
```
Stream ops: `0x01` = open bidi, `0x02` = data, `0x03` = finish, `0x04` = reset.

```typescript
// src/transport/ws-gateway.ts

import type { Transport, Connection, BidiStream, UniSendStream, UniRecvStream } from "./interface.js";
import type { TransportConfig } from "./config.js";

const WS_OP_OPEN_BIDI = 0x01;
const WS_OP_DATA = 0x02;
const WS_OP_FINISH = 0x03;
const WS_OP_RESET = 0x04;

/**
 * WebSocket fallback transport. Connects to an AAFP WebSocket gateway
 * (aafp gateway --ws) which translates WebSocket frames to QUIC streams.
 *
 * Used when neither node:quic nor WebTransport is available.
 * This adds a relay hop — see TYPESCRIPT_SDK_DESIGN.md §3.3 for trade-offs.
 */
export class WsGatewayTransport implements Transport {
  private ws: WebSocket | null = null;
  private readonly gatewayUrl: string;
  private readonly config: TransportConfig;

  constructor(gatewayUrl: string, config: TransportConfig) {
    this.gatewayUrl = gatewayUrl;
    this.config = config;
  }

  get localAddr(): string {
    return `ws-gateway://client`;
  }

  async dial(addr: string): Promise<Connection> {
    // Connect to the gateway, which dials the remote peer over QUIC.
    const url = `${this.gatewayUrl}?target=${encodeURIComponent(addr)}`;
    this.ws = typeof WebSocket !== "undefined"
      ? new WebSocket(url)
      : await import("ws").then((m) => new m.WebSocket(url));
    this.ws.binaryType = "arraybuffer";

    await waitForOpen(this.ws);
    return new WsGatewayConnection(this.ws);
  }

  async accept(): Promise<Connection> {
    throw new Error("WsGatewayTransport does not support accept() — use a QUIC/WebTransport transport for serving");
  }

  async close(): Promise<void> {
    this.ws?.close();
  }
}

class WsGatewayConnection implements Connection {
  private streamCounter = 0n;
  private readonly streams = new Map<bigint, WsGatewayBidiStream>();

  constructor(private ws: WebSocket) {
    // Route incoming data to the appropriate stream.
    ws.addEventListener("message", (event: MessageEvent) => {
      const data = new Uint8Array(event.data instanceof ArrayBuffer ? event.data : event.data.buffer);
      if (data.length < 13) return;
      const op = data[0];
      const streamId = new DataView(data.buffer).getBigUint64(1);
      const payloadLen = new DataView(data.buffer).getUint32(9);
      const payload = data.slice(13, 13 + payloadLen);
      const stream = this.streams.get(streamId);
      if (!stream) return;
      if (op === WS_OP_DATA) stream.onData(payload);
      else if (op === WS_OP_FINISH) stream.onFinish();
      else if (op === WS_OP_RESET) stream.onReset();
    });
  }

  get remoteAddr(): string { return "ws-gateway://peer"; }
  get alpnNegotiated(): boolean { return true; } // gateway handles ALPN

  async openBidiStream(): Promise<BidiStream> {
    const id = this.streamCounter++;
    const stream = new WsGatewayBidiStream(id, this.ws);
    this.streams.set(id, stream);
    // Send OPEN_BIDI op
    this.sendWsFrame(WS_OP_OPEN_BIDI, id, new Uint8Array(0));
    return stream;
  }

  async openUniStream(): Promise<UniSendStream> {
    const id = this.streamCounter++;
    const stream = new WsGatewayUniSendStream(id, this.ws);
    return stream;
  }

  async acceptBidiStream(): Promise<BidiStream> {
    throw new Error("not supported on WebSocket gateway client");
  }
  async acceptUniStream(): Promise<UniRecvStream> {
    throw new Error("not supported on WebSocket gateway client");
  }

  async close(code = 0, reason?: string): Promise<void> {
    this.ws.close(code, reason);
  }

  async exportTlsBinding(label: string, _context?: Uint8Array): Promise<Uint8Array> {
    // No TLS exporter over WebSocket — synthetic binding.
    const hash = new Uint8Array(32);
    crypto.getRandomValues(hash);
    return hash;
  }

  private sendWsFrame(op: number, streamId: bigint, payload: Uint8Array): void {
    const buf = new Uint8Array(13 + payload.length);
    buf[0] = op;
    new DataView(buf.buffer).setBigUint64(1, streamId);
    new DataView(buf.buffer).setUint32(9, payload.length);
    buf.set(payload, 13);
    this.ws.send(buf);
  }
}

class WsGatewayBidiStream implements BidiStream {
  readonly id: bigint;
  private dataQueue: Uint8Array[] = [];
  private resolveRead: ((v: Uint8Array | null) => void) | null = null;
  private finished = false;

  constructor(id: bigint, private ws: WebSocket) {
    this.id = id;
  }

  async write(data: Uint8Array): Promise<void> {
    this.sendWsFrame(WS_OP_DATA, data);
  }

  async finish(): Promise<void> {
    this.sendWsFrame(WS_OP_FINISH, new Uint8Array(0));
  }

  async read(): Promise<Uint8Array | null> {
    if (this.dataQueue.length > 0) return this.dataQueue.shift()!;
    if (this.finished) return null;
    return new Promise((resolve) => { this.resolveRead = resolve; });
  }

  async reset(code = 0): Promise<void> {
    this.sendWsFrame(WS_OP_RESET, new Uint8Array(0));
  }

  /** Called by the connection when data arrives for this stream. */
  onData(data: Uint8Array): void {
    if (this.resolveRead) {
      const r = this.resolveRead;
      this.resolveRead = null;
      r(data);
    } else {
      this.dataQueue.push(data);
    }
  }

  onFinish(): void {
    this.finished = true;
    if (this.resolveRead) {
      const r = this.resolveRead;
      this.resolveRead = null;
      r(null);
    }
  }

  onReset(): void {
    this.finished = true;
    if (this.resolveRead) {
      const r = this.resolveRead;
      this.resolveRead = null;
      r(null);
    }
  }

  private sendWsFrame(op: number, payload: Uint8Array): void {
    const buf = new Uint8Array(13 + payload.length);
    buf[0] = op;
    new DataView(buf.buffer).setBigUint64(1, this.id);
    new DataView(buf.buffer).setUint32(9, payload.length);
    buf.set(payload, 13);
    this.ws.send(buf);
  }
}

class WsGatewayUniSendStream implements UniSendStream {
  readonly id: bigint;
  constructor(id: bigint, private ws: WebSocket) { this.id = id; }

  async write(data: Uint8Array): Promise<void> {
    const buf = new Uint8Array(13 + data.length);
    buf[0] = WS_OP_DATA;
    new DataView(buf.buffer).setBigUint64(1, this.id);
    new DataView(buf.buffer).setUint32(9, data.length);
    buf.set(data, 13);
    this.ws.send(buf);
  }

  async finish(): Promise<void> {
    const buf = new Uint8Array(13);
    buf[0] = WS_OP_FINISH;
    new DataView(buf.buffer).setBigUint64(1, this.id);
    this.ws.send(buf);
  }

  async reset(_code = 0): Promise<void> { await this.finish(); }
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
  });
}
```

---

## 7. Auto-Detection (`src/transport/auto.ts`)

Select the best available transport at runtime. Priority:
1. `node:quic` (Node 25+) — best performance, native QUIC.
2. WebTransport (browser) — native HTTP/3.
3. WebSocket gateway — universal fallback.

```typescript
// src/transport/auto.ts

import type { Transport, TransportFactory, TransportCreateOptions } from "./interface.js";
import { DEFAULT_CONFIG, type TransportConfig } from "./config.js";

export const defaultTransportFactory: TransportFactory = {
  async create(opts: TransportCreateOptions): Promise<Transport> {
    const config = opts.config ?? DEFAULT_CONFIG;

    // 1. node:quic (Node 25+)
    if (typeof process !== "undefined" && hasNodeQuic()) {
      const { NodeQuicTransport } = await import("./node-quic.js");
      return NodeQuicTransport.create({ ...config, bindAddr: opts.bindAddr ?? config.bindAddr });
    }

    // 2. WebTransport (browser / Deno)
    if (typeof WebTransport !== "undefined") {
      const { WebTransportTransport } = await import("./webtransport.js");
      if (opts.role === "server") {
        return WebTransportTransport.createServer(config);
      }
      // Client: return a transport whose dial() takes an https:// URL.
      return new WebTransportTransport(undefined as any, config, "webtransport://client");
    }

    // 3. WebSocket gateway fallback
    const { WsGatewayTransport } = await import("./ws-gateway.js");
    const gatewayUrl = process?.env?.AAFP_WS_GATEWAY ?? "ws://localhost:8080";
    return new WsGatewayTransport(gatewayUrl, config);
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

## 8. In-Memory Transport (`src/transport/in-memory.ts`)

A loopback transport for unit tests. Creates paired transports that
connect to each other in-process — no network, no sockets. This is the TS
equivalent of the Rust test helper that spawns two `QuicTransport`
instances on `127.0.0.1:0`.

```typescript
// src/transport/in-memory.ts

import type { Transport, Connection, BidiStream, UniSendStream, UniRecvStream } from "./interface.js";

/**
 * In-memory loopback transport pair for testing.
 * Creates two transports that connect to each other without network I/O.
 */
export function createInMemoryTransportPair(): [Transport, Transport] {
  const serverQueue: InMemoryConnection[] = [];
  const clientQueue: { resolve: (c: InMemoryConnection) => void }[] = [];

  const server: Transport = new InMemoryTransport("inmem://server", serverQueue, clientQueue);
  const client: Transport = new InMemoryTransport("inmem://client", clientQueue, serverQueue);
  return [server, client];
}

class InMemoryTransport implements Transport {
  constructor(
    private addr: string,
    private acceptQueue: InMemoryConnection[],
    private dialQueue: { resolve: (c: InMemoryConnection) => void }[],
  ) {}

  get localAddr(): string { return this.addr; }

  async dial(_addr: string): Promise<Connection> {
    const [connA, connB] = createInMemoryConnectionPair();
    this.dialQueue.push({ resolve: () => connB });
    this.acceptQueue.push(connA);
    // The other side's accept() will pick up connA.
    return connB;
  }

  async accept(): Promise<Connection> {
    const conn = this.acceptQueue.shift();
    if (conn) return conn;
    return new Promise((resolve) => {
      // Poll — in tests this resolves immediately.
      const check = () => {
        const c = this.acceptQueue.shift();
        if (c) resolve(c);
        else setTimeout(check, 0);
      };
      check();
    });
  }

  async close(): Promise<void> {
    this.acceptQueue.length = 0;
    this.dialQueue.length = 0;
  }
}

function createInMemoryConnectionPair(): [InMemoryConnection, InMemoryConnection] {
  const streamsAtoB: { bidi: InMemoryBidiStream[] } = { bidi: [] };
  const streamsBtoA: { bidi: InMemoryBidiStream[] } = { bidi: [] };
  const connA = new InMemoryConnection("inmem://b", streamsAtoB, streamsBtoA);
  const connB = new InMemoryConnection("inmem://a", streamsBtoA, streamsAtoB);
  return [connA, connB];
}

class InMemoryConnection implements Connection {
  private nextStreamId = 0n;

  constructor(
    private remote: string,
    private outgoing: { bidi: InMemoryBidiStream[] },
    private incoming: { bidi: InMemoryBidiStream[] },
  ) {}

  get remoteAddr(): string { return this.remote; }
  get alpnNegotiated(): boolean { return true; }

  async openBidiStream(): Promise<BidiStream> {
    const id = this.nextStreamId++;
    const [sA, sB] = createInMemoryBidiStreamPair(id);
    this.outgoing.bidi.push(sB); // peer accepts this
    return sA;
  }

  async openUniStream(): Promise<UniSendStream> {
    const id = this.nextStreamId++;
    return new InMemoryUniSendStream(id);
  }

  async acceptBidiStream(): Promise<BidiStream> {
    const stream = this.incoming.bidi.shift();
    if (stream) return stream;
    return new Promise((resolve) => {
      const check = () => {
        const s = this.incoming.bidi.shift();
        if (s) resolve(s);
        else setTimeout(check, 0);
      };
      check();
    });
  }

  async acceptUniStream(): Promise<UniRecvStream> {
    throw new Error("uni stream accept not implemented in in-memory transport");
  }

  async close(): Promise<void> {}
  async exportTlsBinding(): Promise<Uint8Array> {
    const h = new Uint8Array(32);
    crypto.getRandomValues(h);
    return h;
  }
}

function createInMemoryBidiStreamPair(id: bigint): [InMemoryBidiStream, InMemoryBidiStream] {
  const a = new InMemoryBidiStream(id);
  const b = new InMemoryBidiStream(id);
  a.peer = b;
  b.peer = a;
  return [a, b];
}

class InMemoryBidiStream implements BidiStream {
  peer: InMemoryBidiStream | null = null;
  private queue: Uint8Array[] = [];
  private resolveRead: ((v: Uint8Array | null) => void) | null = null;
  private finished = false;

  constructor(readonly id: bigint) {}

  async write(data: Uint8Array): Promise<void> {
    if (!this.peer || this.peer.finished) return;
    if (this.peer.resolveRead) {
      const r = this.peer.resolveRead;
      this.peer.resolveRead = null;
      r(data);
    } else {
      this.peer.queue.push(data);
    }
  }

  async finish(): Promise<void> {
    this.finished = true;
    if (this.peer?.resolveRead) {
      const r = this.peer.resolveRead;
      this.peer.resolveRead = null;
      r(null);
    }
  }

  async read(): Promise<Uint8Array | null> {
    if (this.queue.length > 0) return this.queue.shift()!;
    if (this.finished) return null;
    return new Promise((resolve) => { this.resolveRead = resolve; });
  }

  async reset(_code = 0): Promise<void> { await this.finish(); }
}

class InMemoryUniSendStream implements UniSendStream {
  constructor(readonly id: bigint) {}
  async write(_data: Uint8Array): Promise<void> {}
  async finish(): Promise<void> {}
  async reset(_code = 0): Promise<void> {}
}
```

---

## 9. ALPN Negotiation

ALPN `aafp/1` MUST be negotiated on every QUIC connection (RFC-0002 §2.2,
RFC-0006 §2.3). The enforcement points:

1. **Server side:** The endpoint is configured with `alpn: ["aafp/1"]`.
   Connections that do not offer this ALPN are rejected by the TLS layer.
2. **Client side:** The client advertises `alpn: ["aafp/1"]`. After
   connection, verify `conn.alpnProtocol === "aafp/1"`. If the server did
   not select it, close the connection with error.
3. **WebTransport:** ALPN is `h3` (HTTP/3). The AAFP protocol version is
   negotiated at the application layer via the handshake on stream 0.
4. **WebSocket gateway:** ALPN is handled by the gateway's QUIC connection
   to the remote peer. The WebSocket client trusts the gateway.

The `Connection.alpnNegotiated` property lets the handshake layer verify
ALPN before proceeding. See `NodeQuicTransport.dial()` and
`NodeQuicTransport.accept()` above for the enforcement code.

---

## 10. Unit Tests

### 10.1 Frame Round-Trip Tests (`test/transport/frame.test.ts`)

Test the frame codec for byte-for-byte compatibility with the Rust
implementation. These are the most critical tests — any divergence means
the TS SDK cannot interop with Rust/Python agents.

```typescript
// test/transport/frame.test.ts

import { describe, it, expect } from "vitest"; // or node:test
import {
  encodeFrame, decodeFrame, FrameType, FrameFlags,
  AAFP_VERSION, FRAME_HEADER_SIZE, MAX_PAYLOAD_SIZE,
  dataFrame, handshakeFrame, pingFrame, pongFrame, withMore, hasMore, wireSize,
  FrameError,
} from "../../src/transport/frame.js";

describe("Frame encoding", () => {
  it("encodes a DATA frame with correct header layout", () => {
    const frame = dataFrame(42n, new TextEncoder().encode("hello"));
    const bytes = encodeFrame(frame);

    // 28-byte header + 5-byte payload
    expect(bytes.length).toBe(33);

    const view = new DataView(bytes.buffer);
    expect(view.getUint8(0)).toBe(AAFP_VERSION);       // version
    expect(view.getUint8(1)).toBe(FrameType.Data);     // type
    expect(view.getUint8(2)).toBe(0);                  // flags
    expect(view.getUint8(3)).toBe(0);                  // reserved
    expect(view.getBigUint64(4)).toBe(42n);            // stream ID
    expect(view.getBigUint64(12)).toBe(5n);            // payload len
    expect(view.getBigUint64(20)).toBe(0n);            // extension len
    expect(bytes.slice(28)).toEqual(new TextEncoder().encode("hello"));
  });

  it("round-trips a DATA frame", () => {
    const original = dataFrame(99n, new Uint8Array([1, 2, 3, 4, 5]));
    const encoded = encodeFrame(original);
    const { frame: decoded } = decodeFrame(encoded);

    expect(decoded.type).toBe(FrameType.Data);
    expect(decoded.streamId).toBe(99n);
    expect(decoded.flags).toBe(0);
    expect(Array.from(decoded.payload)).toEqual([1, 2, 3, 4, 5]);
    expect(decoded.extensions.length).toBe(0);
  });

  it("round-trips a HANDSHAKE frame (stream 0)", () => {
    const payload = new Uint8Array(64);
    crypto.getRandomValues(payload);
    const original = handshakeFrame(payload);
    expect(original.streamId).toBe(0n);

    const { frame: decoded } = decodeFrame(encodeFrame(original));
    expect(decoded.type).toBe(FrameType.Handshake);
    expect(decoded.streamId).toBe(0n);
    expect(decoded.payload).toEqual(payload);
  });

  it("round-trips a frame with extensions", () => {
    const ext = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const payload = new Uint8Array([0x01, 0x02]);
    const frame = {
      version: AAFP_VERSION, type: FrameType.Data, flags: 0,
      streamId: 7n, payload, extensions: ext,
    };
    const { frame: decoded } = decodeFrame(encodeFrame(frame));
    expect(Array.from(decoded.extensions)).toEqual([0xaa, 0xbb, 0xcc]);
    expect(Array.from(decoded.payload)).toEqual([0x01, 0x02]);
  });

  it("round-trips PING and PONG frames", () => {
    const ping = pingFrame(10n);
    const pong = pongFrame(10n);
    expect(decodeFrame(encodeFrame(ping)).frame.type).toBe(FrameType.Ping);
    expect(decodeFrame(encodeFrame(pong)).frame.type).toBe(FrameType.Pong);
  });

  it("sets and checks the MORE flag", () => {
    const frame = withMore(dataFrame(1n, new Uint8Array(0)));
    expect(hasMore(frame)).toBe(true);
    expect(frame.flags & FrameFlags.MORE).not.toBe(0);

    const { frame: decoded } = decodeFrame(encodeFrame(frame));
    expect(hasMore(decoded)).toBe(true);
  });

  it("computes wire size correctly", () => {
    const frame = dataFrame(1n, new Uint8Array(100));
    expect(wireSize(frame)).toBe(FRAME_HEADER_SIZE + 100);
  });

  it("rejects payload exceeding MAX_PAYLOAD_SIZE", () => {
    const oversized = new Uint8Array(MAX_PAYLOAD_SIZE + 1);
    expect(() => encodeFrame(dataFrame(1n, oversized))).toThrow(FrameError);
  });

  it("rejects invalid version", () => {
    const frame = dataFrame(1n, new Uint8Array(0));
    const bytes = encodeFrame(frame);
    bytes[0] = 2; // wrong version
    expect(() => decodeFrame(bytes)).toThrow(FrameError);
  });

  it("rejects unknown frame type with critical bit", () => {
    const frame = dataFrame(1n, new Uint8Array(0));
    const bytes = encodeFrame(frame);
    bytes[1] = 0xff; // unknown type
    bytes[2] = FrameFlags.CRITICAL; // critical bit set
    expect(() => decodeFrame(bytes)).toThrow(FrameError);
  });

  it("accepts unknown frame type without critical bit", () => {
    const frame = dataFrame(1n, new Uint8Array(0));
    const bytes = encodeFrame(frame);
    bytes[1] = 0x55; // unknown, non-critical
    bytes[2] = 0;
    const { frame: decoded } = decodeFrame(bytes);
    expect(decoded.type).toBe(0x55);
  });

  it("reports incomplete frames with needed/have", () => {
    const frame = dataFrame(1n, new Uint8Array(100));
    const full = encodeFrame(frame);
    const partial = full.slice(0, 10); // only 10 of 128 bytes
    try {
      decodeFrame(partial);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(FrameError);
      expect((e as FrameError).needed).toBe(FRAME_HEADER_SIZE);
      expect((e as FrameError).have).toBe(10);
    }
  });

  it("returns consumed byte count", () => {
    const frame = dataFrame(1n, new Uint8Array(50));
    const encoded = encodeFrame(frame);
    // Append extra bytes to simulate a buffer with multiple frames.
    const padded = new Uint8Array(encoded.length + 10);
    padded.set(encoded, 0);
    const { consumed } = decodeFrame(padded);
    expect(consumed).toBe(encoded.length);
  });
});
```

### 10.2 Transport Interface Conformance (`test/transport/interface.test.ts`)

A conformance suite that runs against every transport implementation. This
ensures all transports behave identically from the AAFP framing layer's
perspective.

```typescript
// test/transport/interface.test.ts

import { describe, it, expect } from "vitest";
import { createInMemoryTransportPair } from "../../src/transport/in-memory.js";
import type { Transport, Connection, BidiStream } from "../../src/transport/interface.js";

/** Conformance suite — call with any Transport pair. */
export function transportConformanceSuite(
  name: string,
  createPair: () => Promise<[Transport, Transport]>,
) {
  describe(`Transport conformance: ${name}`, () => {
    it("dials and accepts a connection", async () => {
      const [server, client] = await createPair();
      const acceptPromise = server.accept();
      const conn = await client.dial(server.localAddr);
      const serverConn = await acceptPromise;
      expect(conn.remoteAddr).toBeDefined();
      expect(serverConn.remoteAddr).toBeDefined();
      await conn.close();
      await serverConn.close();
    });

    it("opens a bidi stream and exchanges data", async () => {
      const [server, client] = await createPair();
      const acceptPromise = server.accept();
      const clientConn = await client.dial(server.localAddr);
      const serverConn = await acceptPromise;

      const serverStreamPromise = serverConn.acceptBidiStream();
      const clientStream = await clientConn.openBidiStream();
      const serverStream = await serverStreamPromise;

      await clientStream.write(new TextEncoder().encode("ping"));
      const received = await serverStream.read();
      expect(received).not.toBeNull();
      expect(new TextDecoder().decode(received!)).toBe("ping");

      await serverStream.write(new TextEncoder().encode("pong"));
      const response = await clientStream.read();
      expect(new TextDecoder().decode(response!)).toBe("pong");

      await clientStream.finish();
      expect(await serverStream.read()).toBeNull();

      await clientConn.close();
      await serverConn.close();
    });

    it("supports half-close (finish without reset)", async () => {
      const [server, client] = await createPair();
      const acceptPromise = server.accept();
      const clientConn = await client.dial(server.localAddr);
      const serverConn = await acceptPromise;

      const serverStreamPromise = serverConn.acceptBidiStream();
      const clientStream = await clientConn.openBidiStream();
      const serverStream = await serverStreamPromise;

      await clientStream.write(new TextEncoder().encode("data"));
      await clientStream.finish();

      // Server can still read after client finishes.
      const data = await serverStream.read();
      expect(new TextDecoder().decode(data!)).toBe("data");
      expect(await serverStream.read()).toBeNull();

      await clientConn.close();
      await serverConn.close();
    });

    it("reports alpnNegotiated", async () => {
      const [server, client] = await createPair();
      const acceptPromise = server.accept();
      const clientConn = await client.dial(server.localAddr);
      const serverConn = await acceptPromise;
      expect(clientConn.alpnNegotiated).toBe(true);
      expect(serverConn.alpnNegotiated).toBe(true);
      await clientConn.close();
      await serverConn.close();
    });

    it("exports TLS binding (32 bytes)", async () => {
      const [server, client] = await createPair();
      const acceptPromise = server.accept();
      const clientConn = await client.dial(server.localAddr);
      const serverConn = await acceptPromise;
      const binding = await clientConn.exportTlsBinding("aafp-handshake-v1");
      expect(binding.length).toBe(32);
      await clientConn.close();
      await serverConn.close();
    });
  });
}

// Run against in-memory transport.
transportConformanceSuite("InMemoryTransport", async () => createInMemoryTransportPair());

// Run against Node QUIC (only if node:quic is available).
// transportConformanceSuite("NodeQuicTransport", async () => { ... });
```

### 10.3 Config Tests (`test/transport/config.test.ts`)

```typescript
import { describe, it, expect } from "vitest";
import { AAFP_ALPN, DEFAULT_CONFIG, lowLatencyConfig, bulkTransferConfig, CongestionController } from "../../src/transport/config.js";

describe("TransportConfig", () => {
  it("AAFP_ALPN is 'aafp/1'", () => {
    expect(AAFP_ALPN).toBe("aafp/1");
  });

  it("default config has tuned parameters", () => {
    expect(DEFAULT_CONFIG.initialRttMs).toBe(10);
    expect(DEFAULT_CONFIG.maxAckDelayMs).toBe(5);
    expect(DEFAULT_CONFIG.streamInitialMaxData).toBe(1024 * 1024);
    expect(DEFAULT_CONFIG.maxConcurrentStreams).toBe(100);
  });

  it("lowLatency preset uses BBR", () => {
    expect(lowLatencyConfig().congestion).toBe(CongestionController.Bbr);
  });

  it("bulkTransfer preset uses Cubic with 10MB window", () => {
    const c = bulkTransferConfig();
    expect(c.congestion).toBe(CongestionController.Cubic);
    expect(c.streamInitialMaxData).toBe(10 * 1024 * 1024);
  });
});
```

---

## 11. Acceptance Criteria

- [ ] `Transport`, `Connection`, `BidiStream`, `UniStream` interfaces
      defined and exported from `src/transport/interface.ts`.
- [ ] `encodeFrame` / `decodeFrame` produce byte-for-byte identical output
      to `aafp-messaging::framing` for all frame types (verified by golden
      vectors from the Rust conformance crate).
- [ ] `NodeQuicTransport` connects, opens bidi streams, and exchanges data
      against a Rust `QuicTransport` endpoint (interop test).
- [ ] ALPN `aafp/1` is enforced — connections with wrong ALPN are rejected.
- [ ] `WebTransportTransport` connects from a browser to an HTTP/3 server
      and exchanges data on bidi streams.
- [ ] `WsGatewayTransport` connects through an AAFP WebSocket relay and
      multiplexes streams correctly.
- [ ] `InMemoryTransport` passes the full conformance suite (used by all
      higher-layer unit tests).
- [ ] `defaultTransportFactory` auto-detects the best available transport.
- [ ] All frame round-trip tests pass (§10.1).
- [ ] All transport conformance tests pass for `InMemoryTransport` (§10.2).
- [ ] `TransportConfig` presets match Rust `QuicConfig` defaults.
- [ ] No `any` types in public interfaces (use `unknown` or proper types).
- [ ] `npm run build` succeeds with zero TypeScript errors.
- [ ] `npm test` passes with zero failures.

---

## 12. Key Design Decisions (from Rust reference)

1. **Transport-agnostic framing:** The AAFP framing layer operates on
   `BidiStream` / `UniStream`, never on sockets. This mirrors the Rust
   architecture where `QuicSendStream` / `QuicRecvStream` are the
   primitives consumed by `aafp-messaging`.

2. **TOFU at TLS, identity at app layer:** The TLS layer uses self-signed
   certificates with trust-on-first-use (see `NoVerifier` in Rust
   `config.rs`). Agent identity (ML-DSA-65) is verified at the application
   layer via the AAFP handshake. This is because rustls/node:quic do not
   yet support ML-DSA-65 in certificate verification.

3. **PQ KEX in TLS:** The TLS handshake uses X25519MLKEM768 hybrid key
   exchange (post-quantum). This protects against harvest-now-decrypt-later
   attacks. The TS transport enables this when `enablePqKex: true`.

4. **TLS channel binding:** `Connection.exportTlsBinding()` exposes the
   TLS exporter (RFC 5705) so the AAFP handshake can bind the
   application-layer identity to the TLS session. This prevents
   man-in-the-middle attacks. WebTransport and WebSocket fallbacks return
   synthetic bindings — the handshake must account for this.

5. **Stream multiplexing:** QUIC and WebTransport provide native stream
   multiplexing. The WebSocket fallback multiplexes virtual streams over a
   single WebSocket connection using a 13-byte header per chunk.

6. **Config presets:** `lowLatencyConfig()` and `bulkTransferConfig()`
   mirror the Rust `QuicConfig::low_latency()` and
   `QuicConfig::bulk_transfer()` presets exactly.

---

## 13. References

- `TYPESCRIPT_SDK_DESIGN.md` §6 (Transport Abstraction), §7.2 (Frame encoding)
- `implementations/rust/crates/aafp-transport-quic/src/transport.rs` — `QuicTransport`, `QuicConnection`, `QuicSendStream`, `QuicRecvStream`
- `implementations/rust/crates/aafp-transport-quic/src/config.rs` — `QuicConfig`, `AAFP_ALPN`, `NoVerifier`, presets
- `implementations/rust/crates/aafp-messaging/src/framing.rs` — `encode_frame`, `decode_frame`, `FrameType`, `FrameError`
- RFC-0002 §3 (Frame Format), §2.2 (ALPN), §4 (Frame Types)
- RFC-0006 §4.2 (Unknown frame type handling, critical bit)
- RFC-0005 §6 (Error codes)
