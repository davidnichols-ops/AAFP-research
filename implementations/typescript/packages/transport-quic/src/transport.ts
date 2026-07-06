/**
 * Transport abstraction interfaces for the AAFP TypeScript SDK.
 *
 * These interfaces decouple the AAFP handshake, framing, and RPC layers
 * from the underlying byte-stream mechanism (QUIC, WebTransport, or
 * WebSocket). The framing layer operates exclusively on `BidiStream` /
 * `UniStream` byte streams — it never touches sockets directly.
 *
 * This mirrors the Rust `QuicTransport`, `QuicConnection`, `QuicSendStream`,
 * and `QuicRecvStream` types but is runtime-agnostic.
 *
 * @see RFC-0002 §2 (Transport)
 * @see TYPESCRIPT_SDK_DESIGN.md §6 (Transport Abstraction)
 */

import type { TransportConfig } from "./config.js";

/**
 * A multiaddr string identifying a transport endpoint.
 *
 * Examples: `"quic://1.2.3.4:4433"`, `"webtransport://example.com:443"`,
 * `"ws://localhost:8080"`.
 */
export type Multiaddr = string;

/**
 * A bidirectional byte stream — the fundamental unit the AAFP framing
 * layer operates on. Maps to a QUIC bidi stream or a WebTransport bidi
 * stream.
 *
 * Lifecycle:
 *   1. `write()` / `read()` — exchange bytes
 *   2. `finish()` — half-close the send side (send FIN)
 *   3. `read()` returns `null` when the remote side finishes
 *   4. `reset()` — abort the stream with an error code
 *
 * @see RFC-0002 §2.1 (Streams)
 */
export interface BidiStream {
  /**
   * Write bytes to the stream. Resolves when the data has been buffered
   * by the transport (flow control may cause backpressure).
   *
   * @param data - The bytes to send.
   * @throws {Error} If the stream has been reset or the connection is closed.
   */
  write(data: Uint8Array): Promise<void>;

  /**
   * Signal that the send side is finished (half-close, sends a FIN).
   * The receive side may still read pending data.
   *
   * @throws {Error} If the stream has been reset.
   */
  finish(): Promise<void>;

  /**
   * Read the next chunk of bytes.
   *
   * Returns `null` when the stream has ended (remote FIN received).
   * Throws on stream reset.
   *
   * @returns The next chunk of bytes, or `null` at end-of-stream.
   * @throws {Error} If the stream was reset by the peer.
   */
  read(): Promise<Uint8Array | null>;

  /**
   * Abort the stream with an error code (QUIC `STOP_SENDING` /
   * `RST_STREAM`). Both the send and receive sides are terminated.
   *
   * @param code - The application error code (default: 0).
   */
  reset(code?: number): Promise<void>;

  /**
   * The stream ID (for logging and multiplexing).
   * In QUIC this is the native 62-bit stream ID; in other transports
   * it is a locally assigned identifier.
   */
  readonly id: bigint;
}

/**
 * A unidirectional send stream. Maps to a QUIC uni stream (send side).
 * Used for handshake frames and one-way notifications.
 *
 * @see RFC-0002 §2.1 (Streams)
 */
export interface UniSendStream {
  /**
   * Write bytes to the stream. Resolves when the data is buffered.
   *
   * @param data - The bytes to send.
   * @throws {Error} If the stream has been reset or the connection is closed.
   */
  write(data: Uint8Array): Promise<void>;

  /**
   * Signal that the send side is finished (send FIN).
   *
   * @throws {Error} If the stream has been reset.
   */
  finish(): Promise<void>;

  /**
   * Abort the stream with an error code (QUIC `RST_STREAM`).
   *
   * @param code - The application error code (default: 0).
   */
  reset(code?: number): Promise<void>;

  /** The stream ID (for logging and multiplexing). */
  readonly id: bigint;
}

/**
 * A unidirectional receive stream. Maps to a QUIC uni stream (recv side).
 *
 * @see RFC-0002 §2.1 (Streams)
 */
export interface UniRecvStream {
  /**
   * Read the next chunk of bytes.
   *
   * Returns `null` when the stream has ended (remote FIN received).
   * Throws on stream reset.
   *
   * @returns The next chunk of bytes, or `null` at end-of-stream.
   * @throws {Error} If the stream was reset by the peer.
   */
  read(): Promise<Uint8Array | null>;

  /**
   * Stop receiving on this stream (QUIC `STOP_SENDING`).
   *
   * @param code - The application error code (default: 0).
   */
  stop(code?: number): Promise<void>;

  /** The stream ID (for logging and multiplexing). */
  readonly id: bigint;
}

/**
 * A connection to a peer, providing bidirectional and unidirectional
 * streams. Maps to a QUIC connection or a WebTransport session.
 *
 * @see RFC-0002 §2 (Transport)
 */
export interface Connection {
  /**
   * Open a new bidirectional stream.
   *
   * @returns A `BidiStream` for exchanging bytes with the peer.
   * @throws {Error} If the connection is closed or the max concurrent
   *   stream limit has been reached.
   */
  openBidiStream(): Promise<BidiStream>;

  /**
   * Open a new unidirectional stream (send side).
   *
   * @returns A `UniSendStream` for sending bytes to the peer.
   * @throws {Error} If the connection is closed.
   */
  openUniStream(): Promise<UniSendStream>;

  /**
   * Accept an incoming bidirectional stream (server side).
   *
   * @returns A `BidiStream` for exchanging bytes with the peer.
   * @throws {Error} If the connection is closed.
   */
  acceptBidiStream(): Promise<BidiStream>;

  /**
   * Accept an incoming unidirectional stream (server side).
   *
   * @returns A `UniRecvStream` for receiving bytes from the peer.
   * @throws {Error} If the connection is closed.
   */
  acceptUniStream(): Promise<UniRecvStream>;

  /**
   * Close the connection with an optional error code and reason.
   *
   * @param code - The application error code (default: 0).
   * @param reason - A human-readable reason string.
   */
  close(code?: number, reason?: string): Promise<void>;

  /**
   * Export TLS channel binding material (RFC 5705). Used by the AAFP
   * handshake to bind the application-layer identity to the TLS session.
   *
   * Returns a 32-byte binding. Throws if the transport does not support
   * TLS export (e.g., WebSocket fallback returns a synthetic binding).
   *
   * @param label - The exporter label (e.g., `"aafp-handshake-v1"`).
   * @param context - Optional context bytes.
   * @returns A 32-byte channel binding.
   * @throws {Error} If the transport does not support TLS export.
   */
  exportTlsBinding(label: string, context?: Uint8Array): Promise<Uint8Array>;

  /**
   * The peer's address (for logging and routing).
   * Format depends on the transport (e.g., `"quic://1.2.3.4:4433"`).
   */
  readonly remoteAddr: string;

  /**
   * Whether the negotiated ALPN is `aafp/1`.
   * For WebTransport and WebSocket fallbacks, this is `true` (ALPN is
   * handled at a different layer).
   *
   * @see RFC-0002 §2.2 (ALPN)
   */
  readonly alpnNegotiated: boolean;
}

/**
 * Factory that creates transport connections (client) or accepts them
 * (server). Maps to a QUIC endpoint or a WebTransport listener.
 *
 * @see RFC-0002 §2 (Transport)
 */
export interface Transport {
  /**
   * Dial a peer at the given multiaddr (e.g., `"quic://1.2.3.4:4433"`).
   *
   * @param addr - The peer's multiaddr.
   * @returns A `Connection` to the peer.
   * @throws {Error} If the connection attempt fails or ALPN negotiation
   *   does not select `aafp/1`.
   */
  dial(addr: Multiaddr): Promise<Connection>;

  /**
   * Accept an incoming connection (server side).
   *
   * @returns A `Connection` from an incoming peer.
   * @throws {Error} If the transport is closed or ALPN negotiation fails.
   */
  accept(): Promise<Connection>;

  /**
   * The local address this transport is bound to.
   */
  readonly localAddr: Multiaddr;

  /**
   * Close the transport and all associated connections.
   */
  close(): Promise<void>;
}

/**
 * Options for creating a transport via a `TransportFactory`.
 */
export interface TransportCreateOptions {
  /** Whether this transport acts as a client or server. */
  role: "client" | "server";
  /** Address to bind the transport (server). If omitted, uses config default. */
  bindAddr?: string;
  /** Transport configuration. If omitted, uses `DEFAULT_CONFIG`. */
  config?: TransportConfig;
}

/**
 * Factory interface for creating transports with auto-detection.
 */
export interface TransportFactory {
  /**
   * Create a transport with the given options.
   *
   * @param opts - Creation options (role, bind address, config).
   * @returns A `Transport` instance.
   */
  create(opts: TransportCreateOptions): Promise<Transport>;
}
