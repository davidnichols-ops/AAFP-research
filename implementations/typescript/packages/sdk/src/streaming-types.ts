/**
 * @aafp/sdk — v2 streaming type definitions.
 *
 * Defines the {@link HandlerMode} enum and the {@link StreamingResponse} type
 * alias used by the streaming dispatch layer. These mirror
 * `aafp_sdk::simple::HandlerMode` from the Rust v2 design.
 *
 * @packageDocumentation
 */

import type { Response } from "./types";

/**
 * Handler mode — distinguishes unary, server-streaming, client-streaming,
 * and bidirectional handlers.
 *
 * Used for dispatch in the server handler loop and for MORE flag
 * interpretation (streaming vs fragmentation). The mode is a local decision
 * based on which API method was used to register / invoke the handler; no
 * wire-level negotiation is required.
 *
 * Mirrors `aafp_sdk::simple::HandlerMode`.
 */
export enum HandlerMode {
  /** Unary request/response (v1 behavior). Single request, single response. */
  Unary = "unary",
  /** Server streaming: one request → many responses. */
  ServerStreaming = "server_streaming",
  /** Client streaming: many requests → one response. */
  ClientStreaming = "client_streaming",
  /** Bidirectional: many requests ↔ many responses. */
  Bidirectional = "bidirectional",
}

/**
 * Streaming response — a single chunk emitted by a server-streaming or
 * bidirectional handler via `ResponseSender.send()` / `StreamingHandlerContext.send()`.
 *
 * This is a type alias for the framework `Response` type, kept distinct in
 * type position to clarify intent at API boundaries (a streaming handler
 * emits a sequence of `StreamingResponse` chunks rather than a single
 * `Response`). The underlying value is identical.
 */
export type StreamingResponse = Response;
