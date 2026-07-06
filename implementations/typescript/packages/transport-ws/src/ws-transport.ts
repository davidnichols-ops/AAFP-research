/**
 * WebSocket gateway transport for the AAFP TypeScript SDK.
 *
 * Implements the `Transport` interface over a WebSocket connection to an
 * AAFP relay gateway (`aafp gateway --ws`). The gateway translates
 * WebSocket frames to QUIC streams on the server side.
 *
 * This is the fallback transport for environments without QUIC or
 * WebTransport (older browsers, restricted networks). It adds a relay
 * hop — see `TYPESCRIPT_SDK_DESIGN.md` §3.3 for trade-offs.
 *
 * Stream multiplexing over WebSocket:
 * Each AAFP stream is multiplexed over a single WebSocket connection
 * using a simple framing protocol:
 * ```
 * [1 byte: stream op][8 bytes: stream ID][4 bytes: payload length][payload]
 * ```
 *
 * @see RFC-0002 §2 (Transport)
 * @see TYPESCRIPT_SDK_DESIGN.md §3.3 (WebSocket Fallback)
 */

import type {
  Transport,
  Connection,
  BidiStream,
  UniSendStream,
  UniRecvStream,
  Multiaddr,
} from "@aafp/transport-quic";
import type { TransportConfig } from "@aafp/transport-quic";

/**
 * WebSocket gateway transport. Connects to an AAFP WebSocket gateway
 * which translates WebSocket frames to QUIC streams.
 *
 * Used when neither `node:quic` nor WebTransport is available.
 *
 * @example
 * ```typescript
 * const transport = new WsGatewayTransport("ws://localhost:8080", config);
 * const conn = await transport.dial("quic://peer:4433");
 * const stream = await conn.openBidiStream();
 * ```
 */
export class WsGatewayTransport implements Transport {
  /** The underlying WebSocket connection (null until `dial()` is called). */
  private ws: WebSocket | null = null;

  /**
   * @param gatewayUrl - The WebSocket URL of the AAFP gateway.
   * @param config - Transport configuration.
   */
  constructor(
    private readonly gatewayUrl: string,
    private readonly config: TransportConfig,
  ) {}

  /** The local address (always `"ws-gateway://client"` for client-side). */
  get localAddr(): Multiaddr {
    throw new Error("Not implemented");
  }

  /**
   * Dial a peer through the gateway. The gateway connects to the remote
   * peer over QUIC and relays frames over the WebSocket.
   *
   * @param addr - The target peer's multiaddr (e.g., `"quic://1.2.3.4:4433"`).
   * @returns A `Connection` to the remote peer via the gateway.
   * @throws {Error} If the WebSocket connection fails.
   */
  async dial(addr: Multiaddr): Promise<Connection> {
    throw new Error("Not implemented");
  }

  /**
   * Accept is not supported on the WebSocket gateway client.
   *
   * The gateway is a client-side transport — use a QUIC or WebTransport
   * transport for serving.
   *
   * @throws {Error} Always — use QUIC/WebTransport for serving.
   */
  async accept(): Promise<Connection> {
    throw new Error("Not implemented");
  }

  /**
   * Close the transport and the underlying WebSocket connection.
   */
  async close(): Promise<void> {
    throw new Error("Not implemented");
  }
}

/**
 * A connection over the WebSocket gateway. Multiplexes virtual streams
 * over a single WebSocket.
 */
export class WsGatewayConnection implements Connection {
  /**
   * @param ws - The underlying WebSocket connection.
   */
  constructor(private ws: WebSocket) {}

  /** The peer's address (always `"ws-gateway://peer"`). */
  get remoteAddr(): string {
    throw new Error("Not implemented");
  }

  /** ALPN is handled by the gateway's QUIC connection — always `true`. */
  get alpnNegotiated(): boolean {
    throw new Error("Not implemented");
  }

  /**
   * Open a new bidirectional stream over the WebSocket.
   *
   * @returns A `BidiStream` multiplexed over the WebSocket.
   */
  async openBidiStream(): Promise<BidiStream> {
    throw new Error("Not implemented");
  }

  /**
   * Open a new unidirectional send stream over the WebSocket.
   *
   * @returns A `UniSendStream` multiplexed over the WebSocket.
   */
  async openUniStream(): Promise<UniSendStream> {
    throw new Error("Not implemented");
  }

  /**
   * Accept is not supported on the WebSocket gateway client.
   *
   * @throws {Error} Always — not supported on client side.
   */
  async acceptBidiStream(): Promise<BidiStream> {
    throw new Error("Not implemented");
  }

  /**
   * Accept is not supported on the WebSocket gateway client.
   *
   * @throws {Error} Always — not supported on client side.
   */
  async acceptUniStream(): Promise<UniRecvStream> {
    throw new Error("Not implemented");
  }

  /**
   * Close the connection and the underlying WebSocket.
   *
   * @param code - The WebSocket close code (default: 0).
   * @param reason - A human-readable close reason.
   */
  async close(code?: number, reason?: string): Promise<void> {
    throw new Error("Not implemented");
  }

  /**
   * Export TLS channel binding material.
   *
   * WebSocket does not expose a TLS exporter — returns a synthetic 32-byte
   * binding. The AAFP handshake must account for this (it cannot rely on
   * TLS channel binding for WebSocket connections).
   *
   * @param _label - The exporter label (unused — synthetic binding).
   * @param _context - Optional context bytes (unused).
   * @returns A synthetic 32-byte binding.
   */
  async exportTlsBinding(_label: string, _context?: Uint8Array): Promise<Uint8Array> {
    throw new Error("Not implemented");
  }
}

/**
 * A bidirectional stream multiplexed over a WebSocket.
 */
export class WsGatewayBidiStream implements BidiStream {
  readonly id: bigint;

  /**
   * @param id - The virtual stream ID.
   * @param ws - The underlying WebSocket connection.
   */
  constructor(id: bigint, private ws: WebSocket) {
    this.id = id;
  }

  /**
   * Write bytes to the stream (sends a DATA op over the WebSocket).
   *
   * @param data - The bytes to send.
   */
  async write(data: Uint8Array): Promise<void> {
    throw new Error("Not implemented");
  }

  /**
   * Signal that the send side is finished (sends a FIN op).
   */
  async finish(): Promise<void> {
    throw new Error("Not implemented");
  }

  /**
   * Read the next chunk of bytes. Returns `null` at end-of-stream.
   *
   * @returns The next chunk, or `null` when the stream has ended.
   */
  async read(): Promise<Uint8Array | null> {
    throw new Error("Not implemented");
  }

  /**
   * Abort the stream (sends a RESET op).
   *
   * @param _code - The error code (unused in current stub).
   */
  async reset(_code?: number): Promise<void> {
    throw new Error("Not implemented");
  }

  /**
   * Called by the connection when data arrives for this stream.
   *
   * @param _data - The received data bytes.
   */
  onData(_data: Uint8Array): void {
    throw new Error("Not implemented");
  }

  /**
   * Called by the connection when a FIN is received for this stream.
   */
  onFinish(): void {
    throw new Error("Not implemented");
  }

  /**
   * Called by the connection when a RESET is received for this stream.
   */
  onReset(): void {
    throw new Error("Not implemented");
  }
}

/**
 * A unidirectional send stream multiplexed over a WebSocket.
 */
export class WsGatewayUniSendStream implements UniSendStream {
  readonly id: bigint;

  /**
   * @param id - The virtual stream ID.
   * @param ws - The underlying WebSocket connection.
   */
  constructor(id: bigint, private ws: WebSocket) {
    this.id = id;
  }

  /**
   * Write bytes to the stream (sends a DATA op over the WebSocket).
   *
   * @param data - The bytes to send.
   */
  async write(data: Uint8Array): Promise<void> {
    throw new Error("Not implemented");
  }

  /**
   * Signal that the send side is finished (sends a FIN op).
   */
  async finish(): Promise<void> {
    throw new Error("Not implemented");
  }

  /**
   * Abort the stream (sends a RESET op).
   *
   * @param _code - The error code (unused in current stub).
   */
  async reset(_code?: number): Promise<void> {
    throw new Error("Not implemented");
  }
}
