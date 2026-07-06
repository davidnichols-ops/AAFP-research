/**
 * Browser-compatible transport adapters and auto-detection factory.
 *
 * This module provides the transport layer used when the SDK runs in a browser,
 * Deno, or Bun — i.e. any runtime without direct access to `node:quic`. It
 * contains three exports:
 *
 * 1. {@link WebTransportTransport} — wraps the browser `WebTransport`
 *    (HTTP/3) API. This is the primary browser transport for Chrome, Edge,
 *    Firefox, and Safari.
 * 2. {@link WsGatewayTransport} — connects to an AAFP relay
 *    (`aafp gateway --ws`) over a browser `WebSocket` and multiplexes logical
 *    bidi streams over a single socket. This is the universal fallback for
 *    older browsers, restricted networks, and Bun.
 * 3. {@link createTransport} — a runtime feature-detection factory that
 *    selects the best available transport: `node:quic` → WebTransport →
 *    WebSocket gateway, in that order. No build-time flags.
 *
 * WebTransport is HTTP/3-based, not raw QUIC. The ALPN is `h3`, not `aafp/1`.
 * The AAFP handshake still runs on stream 0 (a WebTransport bidi stream), but
 * the TLS layer is the browser's, not AAFP's custom ALPN. The AAFP handshake
 * provides application-layer identity (ML-DSA-65) independent of TLS.
 *
 * PQ TLS note: the browser's TLS stack may not support `X25519MLKEM768` yet.
 * The AAFP handshake's ML-DSA-65 signatures provide post-quantum *identity*
 * even if the TLS KEX is classical. This is a documented trade-off, upgradeable
 * when browsers add PQ KEX.
 *
 * @module @aafp/sdk/browser
 */

import type { Runtime } from "./isomorphic.js";
import { detectRuntime } from "./isomorphic.js";

/**
 * A multiaddr string (e.g. `/ip4/1.2.3.4/udp/443/quic-v1/webtransport`).
 *
 * Defined here as a type alias so this module is self-contained during the
 * pre-build scaffolding phase. The canonical `Multiaddr` type lives in the
 * transport interface module and will be substituted once that module lands.
 */
export type Multiaddr = string;

/**
 * A bidirectional byte stream over a transport connection.
 *
 * One side writes; the other reads. Half-close via {@link BidiStream.finish};
 * abrupt termination via {@link BidiStream.reset}.
 */
export interface BidiStream {
  /** Write a chunk of bytes to the stream. Resolves when the write is flushed. */
  write(data: Uint8Array): Promise<void>;
  /** Half-close the writable side. */
  finish(): Promise<void>;
  /** Read the next chunk, or `null` on remote half-close / reset. */
  read(): Promise<Uint8Array | null>;
  /** Abruptly reset the stream with an application error code. */
  reset(code?: number): Promise<void>;
}

/**
 * A logical connection over which multiple bidi streams can be opened.
 */
export interface Connection {
  /** Open a new bidirectional stream. */
  openBidiStream(): Promise<BidiStream>;
  /** Accept an incoming bidirectional stream (server side). */
  acceptBidiStream(): Promise<BidiStream>;
  /** Close the connection and all associated streams. */
  close(): Promise<void>;
  /** The remote peer's address as a multiaddr string. */
  readonly remoteAddr: string;
}

/**
 * A transport is a factory for connections to/from a peer.
 */
export interface Transport {
  /** Dial (connect to) a remote peer at the given multiaddr. */
  dial(addr: Multiaddr): Promise<Connection>;
  /** Accept an incoming connection (server side). */
  accept(): Promise<Connection>;
  /** The local address as a multiaddr string. */
  readonly localAddr: Multiaddr;
  /** Close the transport listener. */
  close(): Promise<void>;
}

/**
 * Options passed to {@link createTransport} to influence transport selection
 * and supply runtime-specific configuration.
 */
export interface TransportCreateOptions {
  /** Whether the caller wants a client or server transport. */
  role: "client" | "server";
  /** Address to bind a server transport to (ignored for client role). */
  bindAddr?: string;
  /** A WebTransport URL (`https://host:port/aafp`) for the WebTransport path. */
  webTransportUrl?: string;
  /** A WebSocket gateway URL (`wss://host:port/aafp-gateway`) for the fallback. */
  gatewayUrl?: string;
  /**
   * Certificate hashes (SHA-256) for self-signed server certs in local dev.
   * Passed to `WebTransport` as `serverCertificateHashes`.
   */
  serverCertificateHashes?: Array<{ algorithm: "sha-256"; value: Uint8Array }>;
}

/**
 * Browser WebTransport (HTTP/3) transport adapter.
 *
 * Wraps the browser `WebTransport` constructor and maps
 * `WebTransportBidirectionalStream` to the SDK's {@link BidiStream} interface
 * and a `WebTransport` session to {@link Connection}.
 *
 * Browser agents are client-only for v1: {@link Transport.accept} always
 * rejects, because accepting browser connections requires a server-side
 * WebTransport endpoint, which is not implemented in browsers.
 */
export class WebTransportTransport implements Transport {
  /** The local address as a multiaddr string. */
  readonly localAddr: Multiaddr;

  /**
   * Construct from an already-open `WebTransport` session.
   *
   * Prefer {@link WebTransportTransport.create} which awaits `session.ready`.
   */
  constructor(
    private session: unknown,
    localAddr: Multiaddr,
  ) {
    this.localAddr = localAddr;
  }

  /**
   * Create a `WebTransportTransport` by opening a new WebTransport session.
   *
   * @param url     The WebTransport URL (`https://host:port/aafp`).
   * @param opts    WebTransport options (e.g. `serverCertificateHashes`).
   * @returns       A ready-to-use `WebTransportTransport`.
   */
  static async create(
    url: string,
    opts?: TransportCreateOptions,
  ): Promise<WebTransportTransport> {
    // const session = new WebTransport(url, opts);
    // await session.ready;
    // const localAddr = parseWebTransportUrl(url);
    // return new WebTransportTransport(session, localAddr);
    throw new Error("Not implemented");
  }

  /** @inheritdoc */
  async dial(addr: Multiaddr): Promise<Connection> {
    // For WebTransport, dial and connect are the same — the session IS the
    // connection. return new WebTransportConnection(this.session, addrToString(addr));
    throw new Error("Not implemented");
  }

  /** @inheritdoc */
  async accept(): Promise<Connection> {
    throw new Error(
      "Agent.serve() is not supported in the browser for v1. Use a relay or server-side WebTransport endpoint.",
    );
  }

  /** @inheritdoc */
  async close(): Promise<void> {
    // await this.session.close();
    throw new Error("Not implemented");
  }
}

/**
 * WebSocket-to-QUIC gateway transport adapter.
 *
 * Connects to an AAFP relay (`aafp gateway --ws`) over a browser `WebSocket`.
 * The relay translates WebSocket frames ↔ AAFP QUIC streams. Used when neither
 * `node:quic` nor WebTransport is available (old Node, restricted networks,
 * Bun, older Firefox/Safari). The API is identical to the other transports;
 * only latency and the P2P property differ — every message goes
 * browser → relay → QUIC → agent.
 *
 * Logical bidi streams are multiplexed over the single WebSocket using a small
 * framing protocol:
 *
 * ```
 *   [4 bytes: streamId (u32 big-endian)]
 *   [1 byte:  frame type]
 *   [4 bytes: payload length (u32 big-endian)]
 *   [N bytes: payload]
 *
 *   Frame types:
 *     0x01 OPEN   — client opens a new logical stream
 *     0x02 DATA   — payload bytes for the stream
 *     0x03 FIN    — sender half-closed (no payload)
 *     0x04 RESET  — stream aborted (payload = 1-byte reset code)
 *     0x05 PING   — keepalive (no payload)
 *     0x06 PONG   — keepalive response
 * ```
 */
export class WsGatewayTransport implements Transport {
  /** The local address as a multiaddr string. */
  readonly localAddr: Multiaddr;

  /**
   * Construct from an already-open `WebSocket`.
   *
   * Prefer {@link WsGatewayTransport.create} which awaits the socket `open`.
   */
  constructor(
    private ws: unknown,
    localAddr: Multiaddr,
  ) {
    this.localAddr = localAddr;
  }

  /**
   * Create a `WsGatewayTransport` by opening a new WebSocket.
   *
   * The socket is opened with `binaryType = "arraybuffer"`.
   *
   * @param url  The WebSocket gateway URL (`ws://` or `wss://`).
   * @returns    A ready-to-use `WsGatewayTransport`.
   */
  static async create(url: string): Promise<WsGatewayTransport> {
    // const ws = new WebSocket(url);
    // ws.binaryType = "arraybuffer";
    // await once(ws, "open");
    // return new WsGatewayTransport(ws, parseWsUrl(url));
    throw new Error("Not implemented");
  }

  /** @inheritdoc */
  async dial(addr: Multiaddr): Promise<Connection> {
    // The WebSocket itself is the connection; the relay dials the real QUIC peer.
    // return new WsGatewayConnection(this.ws, addrToString(addr));
    throw new Error("Not implemented");
  }

  /** @inheritdoc */
  async accept(): Promise<Connection> {
    throw new Error(
      "WsGatewayTransport does not support server mode in the browser",
    );
  }

  /** @inheritdoc */
  async close(): Promise<void> {
    // this.ws.close();
    throw new Error("Not implemented");
  }
}

/**
 * Returns `true` when the browser `WebTransport` API is available.
 *
 * This is a pure feature-detection check (`typeof WebTransport !== "undefined"`)
 * with no build-time flags.
 */
export function isWebTransportAvailable(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as unknown as { WebTransport?: unknown }).WebTransport !==
      "undefined"
  );
}

/**
 * Returns `true` when the browser `WebSocket` API is available.
 */
export function isWebSocketAvailable(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as unknown as { WebSocket?: unknown }).WebSocket !==
      "undefined"
  );
}

/**
 * Auto-detect the best available transport at runtime and construct it.
 *
 * Selection order (first match wins):
 *   1. **Node.js 25+ with `node:quic`** — full QUIC, ALPN `aafp/1`. The
 *      `node:quic` transport module is dynamically imported so it is excluded
 *      from browser bundles.
 *   2. **Browser / Deno with `WebTransport`** — HTTP/3 transport. The caller
 *      must supply `opts.webTransportUrl`.
 *   3. **WebSocket gateway fallback** — for Bun, old Node, restricted networks,
 *      and older browsers. Uses `opts.gatewayUrl` or a derived default.
 *
 * No build-time flags are used; selection is purely runtime feature detection.
 * Each transport module is loaded via dynamic `import()` so bundlers split it
 * into a separate chunk that is only loaded when its code path is taken.
 *
 * @param opts  Transport creation options (role, URLs, cert hashes).
 * @returns     The best available {@link Transport} for the current runtime.
 */
export async function createTransport(
  opts: TransportCreateOptions,
): Promise<Transport> {
  const runtime: Runtime = detectRuntime();

  // 1. Node.js 25+ with node:quic — dynamically imported, tree-shakeable.
  if (runtime === "node" && hasNodeQuic()) {
    // const { NodeQuicTransport } = await import("./node-quic.js");
    // return new NodeQuicTransport(opts);
    throw new Error("Not implemented: node:quic transport");
  }

  // 2. Browser / Deno with WebTransport.
  if (isWebTransportAvailable()) {
    if (!opts.webTransportUrl) {
      throw new Error(
        "createTransport: webTransportUrl is required when using the WebTransport path",
      );
    }
    return WebTransportTransport.create(opts.webTransportUrl, opts);
  }

  // 3. WebSocket gateway fallback (Bun, old Node, restricted networks).
  if (isWebSocketAvailable()) {
    const url = opts.gatewayUrl ?? defaultGatewayUrl();
    return WsGatewayTransport.create(url);
  }

  throw new Error(
    "createTransport: no supported transport available in this runtime",
  );
}

/**
 * Detect whether `node:quic` is available in the current Node.js process.
 *
 * Uses a guarded dynamic access so it never throws in non-Node runtimes.
 */
function hasNodeQuic(): boolean {
  try {
    const g = globalThis as unknown as {
      require?: (mod: string) => unknown;
    };
    return !!g.require?.("node:quic");
  } catch {
    return false;
  }
}

/**
 * Derive a default WebSocket gateway URL when none is supplied.
 *
 * In a browser, this is same-origin: `wss://` for HTTPS pages, `ws://` for
 * HTTP. Otherwise, defaults to `ws://localhost:9000/aafp-gateway`.
 */
function defaultGatewayUrl(): string {
  const loc = globalThis as unknown as {
    location?: { protocol: string; host: string };
  };
  if (loc.location) {
    const proto = loc.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${loc.location.host}/aafp-gateway`;
  }
  return "ws://localhost:9000/aafp-gateway";
}
