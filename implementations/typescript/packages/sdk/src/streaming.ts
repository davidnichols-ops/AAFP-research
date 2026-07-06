/**
 * @aafp/sdk — v2 streaming primitives.
 *
 * Implements the core streaming classes that expose AAFP's QUIC bidirectional
 * streams and the MORE flag as idiomatic TypeScript async iterables. Three
 * streaming patterns are supported: server-streaming, client-streaming, and
 * bidirectional. Cancellation flows through `AbortSignal` and maps to QUIC
 * stream reset.
 *
 * Classes defined here:
 * - {@link StreamingHandlerContext} — server-side handler context (signal +
 *   response sender + capability).
 * - {@link ResponseSender} — wraps the QUIC send stream; encodes each
 *   `Response` as an `RPC_RESPONSE` frame with the MORE flag.
 * - {@link ResponseStream} — client-side `AsyncIterable<Response>` consuming
 *   response frames from the QUIC recv stream.
 * - {@link BidiSession} — client-side bidirectional handle: a request sender
 *   plus a response `AsyncIterable`.
 *
 * Mirrors `aafp_sdk::simple` (Rust), adapted to TS async iterables and
 * `AbortSignal` instead of mpsc channels and `CancellationToken`.
 *
 * @packageDocumentation
 */

import type { Request, Response } from "./types";
import type { HandlerError } from "./errors";

/**
 * Streaming handler context — provides a response sender for streaming
 * handlers. Mirrors `aafp_sdk::simple::StreamingHandlerContext`.
 *
 * The `AbortSignal` fires when the client disconnects or cancels the stream
 * (via QUIC stream reset). Handlers SHOULD check `signal.aborted` or the
 * `cancelled` getter before producing each chunk.
 */
export class StreamingHandlerContext {
  /** Fires when the client disconnects or cancels the stream. */
  readonly signal: AbortSignal;
  /** The capability being invoked. */
  readonly capability: string;
  private readonly sender: ResponseSender;

  /**
   * @param signal - AbortSignal that fires on client disconnect / cancel.
   * @param capability - The capability name being invoked.
   * @param sender - The underlying response sender wrapping the QUIC send stream.
   */
  constructor(
    signal: AbortSignal,
    capability: string,
    sender: ResponseSender,
  ) {
    this.signal = signal;
    this.capability = capability;
    this.sender = sender;
  }

  /**
   * Send a response chunk to the client. Rejects if the stream is closed.
   *
   * The chunk is encoded as an `RPC_RESPONSE` frame with the MORE flag set;
   * the QUIC send stream stays open for subsequent chunks.
   *
   * @param resp - The response chunk to send.
   */
  async send(resp: Response): Promise<void> {
    await this.sender.send(resp);
  }

  /**
   * Send an error frame and close the stream.
   *
   * Writes an `RPC_RESPONSE` error frame (no MORE flag — final frame), then
   * half-closes the send stream.
   *
   * @param err - The handler error to transmit.
   */
  async error(err: HandlerError): Promise<void> {
    await this.sender.error(err);
  }

  /**
   * Explicitly close the stream (no more responses).
   *
   * Writes the final frame without the MORE flag and half-closes the send
   * stream. Safe to call multiple times.
   */
  async close(): Promise<void> {
    await this.sender.close();
  }

  /** True if the client has cancelled or disconnected. */
  get cancelled(): boolean {
    return this.signal.aborted;
  }
}

/**
 * Response sender — wraps the QUIC send stream for streaming handlers.
 * Encodes each `Response` as an `RPC_RESPONSE` frame with the MORE flag.
 *
 * Lifecycle:
 * - `send(resp)` — write frame with MORE flag, keep stream open.
 * - `error(err)` — write error frame (no MORE), then close stream.
 * - `close()` — write final frame without MORE, then half-close (finish).
 *
 * Mirrors `aafp_sdk::simple::ResponseSender` (Rust mpsc::Sender wrapper).
 */
export class ResponseSender {
  private readonly sendStream: QuicSendStream;
  private readonly rpcId: number;
  private readonly abortController: AbortController;
  private closed = false;

  /**
   * @param sendStream - The QUIC send stream to write frames to.
   * @param rpcId - The RPC request id this sender responds to.
   * @param abortController - Controller whose signal fires on client cancel.
   */
  constructor(
    sendStream: QuicSendStream,
    rpcId: number,
    abortController: AbortController,
  ) {
    this.sendStream = sendStream;
    this.rpcId = rpcId;
    this.abortController = abortController;
  }

  /**
   * Send a response chunk (MORE flag set, stream stays open).
   *
   * @param resp - The response chunk to encode and write.
   * @throws if the stream is already closed or has been cancelled by the client.
   */
  async send(resp: Response): Promise<void> {
    throw new Error("Not implemented");
  }

  /**
   * Send an error frame and close the stream.
   *
   * Writes an `RPC_RESPONSE` error frame without the MORE flag (final frame),
   * then half-closes the QUIC send stream. No-op if already closed.
   *
   * @param err - The handler error to transmit.
   */
  async error(err: HandlerError): Promise<void> {
    throw new Error("Not implemented");
  }

  /**
   * Close the stream cleanly (final frame without MORE, then finish).
   *
   * Half-closes the QUIC send stream so the server signals no more data.
   * Safe to call multiple times.
   */
  async close(): Promise<void> {
    throw new Error("Not implemented");
  }

  /** True if the sender has been closed (via `close()` or `error()`). */
  get isClosed(): boolean {
    return this.closed;
  }
}

/**
 * Response stream — client-side async iterable of `Response` chunks.
 *
 * Implements `AsyncIterable<Response>` for `for await...of` consumption.
 * Reads `RPC_RESPONSE` frames from the QUIC recv stream. Each frame with the
 * MORE flag yields a `Response`; a frame without MORE (or stream end)
 * terminates the iterator. Error frames throw a `HandlerError`.
 *
 * Cancellation: if the consumer breaks out of `for await` early, the `finally`
 * block resets the QUIC send stream (`sendStream.reset(0)`), notifying the
 * server to stop. An explicit `cancel()` is also available.
 *
 * Single-consumer: the async iterator may only be consumed once; a second
 * attempt throws.
 *
 * Mirrors `aafp_sdk::simple::ResponseStream` (Rust mpsc::Receiver wrapper),
 * adapted to TS async iterables instead of manual `.next()` polling.
 */
export class ResponseStream implements AsyncIterable<Response> {
  private readonly recvStream: QuicRecvStream;
  private readonly sendStream: QuicSendStream;
  private readonly signal: AbortSignal;
  private consumed = false;

  /**
   * @param recvStream - The QUIC recv stream to read response frames from.
   * @param sendStream - The QUIC send stream, used for cancellation reset.
   * @param signal - AbortSignal linked to the caller's cancellation.
   */
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
   *
   * Yields each `Response` chunk; throws `HandlerError` on error frames.
   * Terminates when a frame without the MORE flag arrives or the stream
   * ends. On early exit (consumer `break`), resets the send stream to
   * cancel the server-side handler.
   */
  async *[Symbol.asyncIterator](): AsyncIterator<Response> {
    if (this.consumed) {
      throw new Error("ResponseStream: already consumed");
    }
    this.consumed = true;
    throw new Error("Not implemented");
  }

  /**
   * Cancel the stream (alternative to `AbortSignal`).
   *
   * Resets the QUIC send stream, notifying the server to stop producing
   * chunks. Idempotent.
   */
  cancel(): void {
    throw new Error("Not implemented");
  }
}

/**
 * Bidirectional session — client-side handle for bidi streaming.
 *
 * Combines a request sender with a response async iterable. The caller sends
 * requests via `send()` / `finish()`, and consumes responses via
 * `for await...of` on the session itself.
 *
 * Internally spawns a background reader that reads response frames from the
 * QUIC recv stream and buffers them for iteration. Outgoing requests are
 * drained from an internal queue into the QUIC send stream with the MORE flag
 * always set (the stream stays open until `finish()`).
 *
 * Cancellation: breaking out of `for await` early resets both directions.
 * `cancel()` is also available for explicit cancellation.
 *
 * Single-consumer: the async iterator may only be started once.
 *
 * Mirrors `aafp_sdk::simple::BidiSession` (Rust mpsc channels), adapted to
 * TS async iterables.
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

  /**
   * @param sendStream - The QUIC send stream for outgoing requests.
   * @param recvStream - The QUIC recv stream for incoming responses.
   * @param signal - AbortSignal linked to the caller's cancellation.
   */
  constructor(
    sendStream: QuicSendStream,
    recvStream: QuicRecvStream,
    signal: AbortSignal,
  ) {
    this.sendStream = sendStream;
    this.recvStream = recvStream;
    this.signal = signal;
  }

  /**
   * Send a request to the server (MORE flag always set for bidi).
   *
   * @param req - The request to enqueue and flush.
   * @throws if the send side has already been closed via `finish()`.
   */
  send(req: Request): void {
    throw new Error("Not implemented");
  }

  /**
   * Half-close the send side (no more requests).
   *
   * Flushes any queued requests, then finishes the QUIC send stream to
   * signal to the server that no more requests will follow.
   */
  finish(): void {
    throw new Error("Not implemented");
  }

  /**
   * Cancel the entire session (resets both directions).
   *
   * Resets the QUIC send stream and stops the QUIC recv stream. Idempotent.
   */
  cancel(): void {
    throw new Error("Not implemented");
  }

  /**
   * AsyncIterator — yields responses as they arrive from the server.
   *
   * Spawns a background reader task that decodes response frames and buffers
   * them. Each iteration drains the buffer; when the server closes the stream
   * (frame without MORE or stream end) the iterator completes. On early exit
   * (consumer `break`), both directions are reset.
   *
   * @throws if the iterator has already been started (single-consumer).
   */
  async *[Symbol.asyncIterator](): AsyncIterator<Response> {
    if (this.iteratorStarted) {
      throw new Error("BidiSession: iterator already started");
    }
    this.iteratorStarted = true;
    throw new Error("Not implemented");
  }
}

// ---------------------------------------------------------------------------
// Forward-declared transport stubs.
//
// These minimal interface declarations let the streaming classes type-check
// against the QUIC transport surface without importing the (not-yet-created)
// transport module. The real `QuicSendStream` / `QuicRecvStream` types live in
// `./transport` and will replace these once Phase 1 (transport) is built.
// ---------------------------------------------------------------------------

/**
 * Minimal QUIC send-stream surface used by the streaming primitives.
 * The real type is defined in `./transport`.
 */
export interface QuicSendStream {
  /** Write encoded frame bytes to the stream. */
  write(data: Uint8Array): Promise<void>;
  /** Half-close: signal no more data will be written. */
  finish(): void;
  /** Reset the stream with the given error code (cancellation). */
  reset(code: number): void;
}

/**
 * Minimal QUIC recv-stream surface used by the streaming primitives.
 * The real type is defined in `./transport`.
 */
export interface QuicRecvStream {
  /** Read exactly `n` bytes, or return `null` if the stream ended. */
  readExact(n: number): Promise<Uint8Array | null>;
  /** Stop receiving with the given error code (cancellation). */
  stop(code: number): void;
  /** Register a callback fired when the peer resets / stops the stream. */
  onStop(cb: (code: number) => void): void;
}
