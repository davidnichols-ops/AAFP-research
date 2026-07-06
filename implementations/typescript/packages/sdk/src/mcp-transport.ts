// AAFP SDK — MCP Transport Binding (Phase 7, Part 1)
//
// STUB FILE — Pre-build scaffolding. All method bodies throw
// `Error('Not implemented')`. Implementation deferred to Phase 7 build.
//
// Implements the MCP TypeScript SDK `Transport` interface, carrying JSON-RPC
// 2.0 messages as payloads of AAFP DATA frames over a bidirectional
// QUIC/WebTransport stream. See RFC-0007 and TS_PHASE_7_MCP.md Part 1.

import type { Transport, JSONRPCMessage, TransportSendOptions } from "@modelcontextprotocol/sdk/types.js";

/**
 * AAFP-backed transport for the MCP TypeScript SDK.
 *
 * Implements the MCP `Transport` interface, carrying JSON-RPC 2.0 messages
 * as payloads of AAFP DATA frames over a bidirectional QUIC/WebTransport
 * stream. The AAFP v1 handshake (ML-DSA-65 identity verification, PQ KEX)
 * is performed during construction via `AafpMcpTransport.connect()` or
 * `AafpMcpTransport.accept()`.
 *
 * Wire format per RFC-0007:
 *   [AAFP Frame Header (28 bytes)] [JSON-RPC message (UTF-8 JSON)]
 *
 * Each MCP message is exactly one DATA frame. JSON is preserved byte-for-byte
 * (no CBOR transcoding, no reordering, no coalescing).
 *
 * Mandatory requirements (RFC-0007):
 * - AAFP v1 handshake before any MCP message (no unauthenticated connections)
 * - ML-DSA-65 identity verification; AgentId derived from verified public key
 * - Session in `MessagingEnabled` state before opening application streams
 * - DATA frames (type 0x01) for MCP messages — NOT RPC_REQUEST/RPC_RESPONSE
 * - JSON preserved byte-for-byte — no CBOR transcoding, no reordering
 * - Stream IDs ≥ 4 for application data (stream 0 = handshake, 1-2 reserved)
 *
 * Prohibited (RFC-0007):
 * - No X.509 certificates for agent identity
 * - No HTTP fallback if AAFP handshake fails
 * - No message modification / coalescing — one MCP message = one DATA frame
 */
export class AafpMcpTransport implements Transport {
  /** Called by the MCP SDK when the transport closes. */
  onclose?: () => void;
  /** Called by the MCP SDK to receive errors. */
  onerror?: (error: Error) => void;
  /** Called by the MCP SDK to deliver inbound JSON-RPC messages. */
  onmessage?: (message: JSONRPCMessage) => void;
  /** MCP session identifier (set by the SDK during `initialize`). */
  sessionId?: string;
  /** Called by the MCP SDK to negotiate the protocol version. */
  setProtocolVersion?: (version: string) => void;

  /**
   * Private constructor — use {@link AafpMcpTransport.connect} or
   * {@link AafpMcpTransport.accept} to create instances.
   *
   * @param conn    The AAFP `Connection` (already handshaked).
   * @param peerAgentId The verified peer AgentId (ML-DSA-65), captured from
   *                    the handshake.
   * @param isClient `true` for the client side (opens the bidi stream),
   *                 `false` for the server side (accepts the bidi stream).
   */
  private constructor(
    private readonly conn: unknown,
    private readonly peerAgentId: string | undefined,
    private readonly isClient: boolean,
  ) {}

  /**
   * Client-side factory: dial an AAFP agent, perform the v1 handshake, and
   * return an `AafpMcpTransport` ready for `start()`.
   *
   * The `conn` argument is an already-established, handshaked AAFP
   * `Connection` (the caller is responsible for the handshake and
   * authorization). `addr` is `quic://host:port` or
   * `webtransport://host:port`.
   *
   * @param conn    A handshaked AAFP `Connection`.
   * @param isClient Whether this is the client side (default `true`).
   * @returns A new `AafpMcpTransport` (not yet started).
   */
  static async connect(
    conn: unknown,
    isClient = true,
  ): Promise<AafpMcpTransport> {
    throw new Error("Not implemented");
  }

  /**
   * Server-side factory: wrap an already-accepted AAFP `Connection` as an
   * MCP transport. The caller is responsible for accepting the connection
   * and performing the handshake + authorization before calling this.
   *
   * @param conn An accepted, handshaked AAFP `Connection`.
   * @returns A new `AafpMcpTransport` (not yet started).
   */
  static accept(conn: unknown): AafpMcpTransport {
    throw new Error("Not implemented");
  }

  /**
   * The verified peer AgentId (ML-DSA-65), captured from the AAFP handshake.
   * Undefined if the peer did not present an identity or the connection was
   * not yet handshaked.
   */
  get peerId(): string | undefined {
    throw new Error("Not implemented");
  }

  /**
   * Start the transport. Called by the MCP SDK after registering the
   * `onmessage` / `onclose` / `onerror` callbacks.
   *
   * Opens the bidirectional application stream (stream ID ≥ 4 per
   * RFC-0002 §7.1) and starts the read loop. On the client side the stream
   * is opened; on the server side the client-initiated stream is accepted.
   */
  async start(): Promise<void> {
    throw new Error("Not implemented");
  }

  /**
   * Send a JSON-RPC message as exactly one AAFP DATA frame (type 0x01).
   *
   * The JSON is serialized with `JSON.stringify` and encoded as UTF-8. It is
   * NOT modified, transcoded to CBOR, reordered, or coalesced with other
   * messages — byte-for-byte preservation is a mandatory requirement of
   * RFC-0007.
   *
   * @param message The JSON-RPC 2.0 message to send.
   * @param options Optional send options (e.g. `relatedRequestId`); currently
   *                ignored by the AAFP transport.
   * @throws Error if the transport is closed or no stream is open.
   */
  async send(
    message: JSONRPCMessage,
    _options?: TransportSendOptions,
  ): Promise<void> {
    throw new Error("Not implemented");
  }

  /**
   * Graceful close: finish the send side of the stream, close the AAFP
   * connection, and notify the MCP SDK via `onclose`. Idempotent — calling
   * `close()` after the transport is already closed is a no-op.
   */
  async close(): Promise<void> {
    throw new Error("Not implemented");
  }

  /**
   * Read loop: read AAFP DATA frames, decode the JSON-RPC payload, and
   * deliver each message to `onmessage`.
   *
   * Behavior per RFC-0007:
   * - Peer stream close/reset → EOF: the loop exits cleanly and calls
   *   `onclose`. It does NOT throw.
   * - JSON parse errors → logged at `warn` (NOT `error`), the frame is
   *   skipped, and the loop continues. A single malformed message does not
   *   tear down the transport.
   * - Other read errors → delivered to `onerror`, then `onclose`.
   */
  private async readLoop(): Promise<void> {
    throw new Error("Not implemented");
  }

  /**
   * Read exactly `n` bytes from the stream, or return `null` if the peer
   * closed the stream before any bytes arrived (EOF).
   *
   * @param n Number of bytes to read.
   * @returns The bytes, or `null` on clean EOF.
   */
  private async readExact(n: number): Promise<Uint8Array | null> {
    throw new Error("Not implemented");
  }

  /**
   * Given a 28-byte frame header, read the full payload. Throws on a
   * truncated frame (peer closed mid-frame).
   *
   * @param header The 28-byte AAFP frame header.
   * @returns The decoded payload bytes.
   */
  private async readFullFrame(header: Uint8Array): Promise<{ payload: Uint8Array }> {
    throw new Error("Not implemented");
  }
}
