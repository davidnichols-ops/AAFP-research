/**
 * Handler context, typed errors, and handler function signatures.
 *
 * Defines the {@link HandlerContext} with `AbortSignal`-based cancellation,
 * the {@link HandlerError} class with 8 RFC-0005 error categories, the
 * {@link StreamingHandlerContext} for server-streaming handlers, and the
 * type aliases for all handler function signatures.
 *
 * @module handler
 */

import type { Request, Response } from "./types.js";

// ─── HandlerErrorCategory (RFC-0005 error categories) ───────────

/**
 * The 8 RFC-0005 error categories.
 *
 * Each category maps to a range of error codes (determined by the thousands
 * digit) and has a default code used when none is explicitly provided.
 *
 * | Category       | Code range | Default code | Default name              |
 * |----------------|------------|--------------|---------------------------|
 * | Transport      | 1xxx       | 1001         | CONNECTION_RESET          |
 * | Authentication | 2xxx       | 2001         | INVALID_SIGNATURE         |
 * | Authorization  | 3xxx       | 3001         | UNAUTHORIZED              |
 * | Discovery      | 4xxx       | 4005         | CAPABILITY_NOT_FOUND      |
 * | Messaging      | 5xxx       | 5004         | METHOD_PARAMS_INVALID     |
 * | Capability     | 6xxx       | 6003         | UNSUPPORTED_CAPABILITY    |
 * | Protocol       | 8xxx       | 8009         | PROTOCOL_VIOLATION        |
 * | Application    | 9xxx       | 9000         | (generic application err) |
 */
export enum HandlerErrorCategory {
  /** Transport error (1xxx). Default: 1001 CONNECTION_RESET. */
  Transport = "Transport",
  /** Authentication error (2xxx). Default: 2001 INVALID_SIGNATURE. */
  Authentication = "Authentication",
  /** Authorization error (3xxx). Default: 3001 UNAUTHORIZED. */
  Authorization = "Authorization",
  /** Discovery error (4xxx). Default: 4005 CAPABILITY_NOT_FOUND. */
  Discovery = "Discovery",
  /** Messaging error (5xxx). Default: 5004 METHOD_PARAMS_INVALID. */
  Messaging = "Messaging",
  /** Capability error (6xxx). Default: 6003 UNSUPPORTED_CAPABILITY. */
  Capability = "Capability",
  /** Protocol error (8xxx). Default: 8009 PROTOCOL_VIOLATION. */
  Protocol = "Protocol",
  /** Application error (9xxx). Default: 9000. */
  Application = "Application",
}

// ─── HandlerError ───────────────────────────────────────────────

/**
 * Typed error for handler responses (v2).
 *
 * Maps to RFC-0005 error code categories. Handlers throw `HandlerError`
 * to provide structured error information instead of a plain string.
 *
 * @example
 * ```typescript
 * throw new HandlerError(
 *   HandlerErrorCategory.Messaging,
 *   "missing params: expected keys 1 and 2",
 * );
 * ```
 */
export class HandlerError extends Error {
  /** The error category. */
  readonly category: HandlerErrorCategory;
  /** The RFC-0005 error code. */
  readonly code: number;

  /**
   * Create a HandlerError.
   * @param category - The error category.
   * @param message - Human-readable error message.
   * @param code - Optional explicit error code. Defaults to the category's default code.
   */
  constructor(category: HandlerErrorCategory, message: string, code?: number) {
    super(message);
    this.name = "HandlerError";
    this.category = category;
    this.code = code ?? defaultCodeForCategory(category);
  }

  /**
   * Create a HandlerError from a wire error code and message.
   *
   * The category is inferred from the thousands digit of the code.
   * @param code - The RFC-0005 error code.
   * @param message - Human-readable error message.
   * @returns A new HandlerError with the inferred category.
   */
  static fromCode(code: number, message: string): HandlerError {
    throw new Error("Not implemented");
  }
}

/**
 * Get the default RFC-0005 error code for a category.
 * @param cat - The error category.
 * @returns The default error code.
 */
function defaultCodeForCategory(cat: HandlerErrorCategory): number {
  switch (cat) {
    case HandlerErrorCategory.Transport:
      return 1001; // CONNECTION_RESET
    case HandlerErrorCategory.Authentication:
      return 2001; // INVALID_SIGNATURE
    case HandlerErrorCategory.Authorization:
      return 3001; // UNAUTHORIZED
    case HandlerErrorCategory.Discovery:
      return 4005; // CAPABILITY_NOT_FOUND
    case HandlerErrorCategory.Messaging:
      return 5004; // METHOD_PARAMS_INVALID
    case HandlerErrorCategory.Capability:
      return 6003; // UNSUPPORTED_CAPABILITY
    case HandlerErrorCategory.Protocol:
      return 8009; // PROTOCOL_VIOLATION
    case HandlerErrorCategory.Application:
      return 9000;
  }
}

/**
 * Infer the error category from a wire error code.
 *
 * Uses the thousands digit: 1→Transport, 2→Authentication, etc.
 * @param code - The RFC-0005 error code.
 * @returns The inferred category (defaults to Protocol for unknown prefixes).
 */
function categoryFromCode(code: number): HandlerErrorCategory {
  const prefix = Math.floor(code / 1000);
  switch (prefix) {
    case 1:
      return HandlerErrorCategory.Transport;
    case 2:
      return HandlerErrorCategory.Authentication;
    case 3:
      return HandlerErrorCategory.Authorization;
    case 4:
      return HandlerErrorCategory.Discovery;
    case 5:
      return HandlerErrorCategory.Messaging;
    case 6:
      return HandlerErrorCategory.Capability;
    case 8:
      return HandlerErrorCategory.Protocol;
    case 9:
      return HandlerErrorCategory.Application;
    default:
      return HandlerErrorCategory.Protocol;
  }
}

// ─── HandlerContext (AbortSignal-based cancellation) ────────────

/**
 * Handler context with `AbortSignal`-based cancellation (v2).
 *
 * Passed to handlers registered via `onCapability()`. The signal fires
 * when the client disconnects, allowing handlers to abort long-running
 * operations. This is the TypeScript equivalent of Rust's
 * `CancellationToken`.
 */
export class HandlerContext {
  /** AbortSignal that fires when the client disconnects. */
  readonly signal: AbortSignal;
  /** The capability being invoked. */
  readonly capability: string;

  /**
   * @param signal - AbortSignal for cancellation.
   * @param capability - The capability name being invoked.
   */
  constructor(signal: AbortSignal, capability: string) {
    this.signal = signal;
    this.capability = capability;
  }

  /** Whether the handler has been cancelled (client disconnected). */
  get cancelled(): boolean {
    throw new Error("Not implemented");
  }

  /**
   * Throw a {@link HandlerError} (Messaging category) if the handler
   * has been cancelled.
   * @throws {HandlerError} If the signal has been aborted.
   */
  throwIfCancelled(): void {
    throw new Error("Not implemented");
  }
}

// ─── StreamingHandlerContext ────────────────────────────────────

/**
 * Context for streaming handlers (v2).
 *
 * Contains an `AbortSignal` for cancellation, the capability name, and
 * a `send()` method for streaming multiple response frames to the client.
 */
export class StreamingHandlerContext {
  /** AbortSignal that fires when the client disconnects. */
  readonly signal: AbortSignal;
  /** The capability being invoked. */
  readonly capability: string;
  /** Internal sender function for writing responses to the stream. */
  private readonly sender: (resp: Response | HandlerError) => Promise<void>;

  /**
   * @param signal - AbortSignal for cancellation.
   * @param capability - The capability name being invoked.
   * @param sender - Function that writes a response or error to the stream.
   */
  constructor(
    signal: AbortSignal,
    capability: string,
    sender: (resp: Response | HandlerError) => Promise<void>,
  ) {
    this.signal = signal;
    this.capability = capability;
    this.sender = sender;
  }

  /**
   * Send a response frame to the client.
   * @param resp - The response to send.
   */
  async send(resp: Response): Promise<void> {
    throw new Error("Not implemented");
  }

  /**
   * Send an error frame to the client and close the stream.
   * @param err - The error to send.
   */
  async error(err: HandlerError): Promise<void> {
    throw new Error("Not implemented");
  }

  /** Whether the handler has been cancelled (client disconnected). */
  get cancelled(): boolean {
    throw new Error("Not implemented");
  }
}

// ─── Handler function signatures ────────────────────────────────

/**
 * v2 capability handler function signature.
 *
 * Receives a {@link Request} and a {@link HandlerContext} with cancellation
 * and capability info. Returns a {@link Response} or throws a
 * {@link HandlerError}.
 */
export type CapabilityHandler = (
  req: Request,
  ctx: HandlerContext,
) => Promise<Response>;

/**
 * v2 server-streaming handler function signature.
 *
 * Receives a {@link Request} and a {@link StreamingHandlerContext} with a
 * `send()` method for streaming multiple response frames to the client.
 * The handler runs until it returns, errors, or the client disconnects.
 */
export type StreamingHandler = (
  req: Request,
  ctx: StreamingHandlerContext,
) => Promise<void>;

/**
 * v2 bidirectional streaming handler function signature.
 *
 * Receives an `AsyncIterable` of {@link Request} objects and a
 * {@link StreamingHandlerContext} for sending responses.
 */
export type BidirectionalHandler = (
  requests: AsyncIterable<Request>,
  ctx: StreamingHandlerContext,
) => Promise<void>;

/**
 * v1 legacy handler function signature (deprecated).
 *
 * Receives a {@link Request} without a context and returns a
 * {@link Response}. Use {@link CapabilityHandler} with `onCapability()`
 * for per-capability routing (v2).
 * @deprecated Use `onCapability()` for per-capability routing.
 */
export type LegacyHandler = (req: Request) => Promise<Response>;
