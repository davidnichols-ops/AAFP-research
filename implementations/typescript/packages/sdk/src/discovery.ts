/**
 * @aafp/sdk — Discovery and direct-call builders for the v2 client API.
 *
 * The `DiscoveryBuilder` discovers agents by capability and calls them with
 * failover across all candidates. The `DirectCallBuilder` calls a specific
 * agent by its AgentId, bypassing capability-based discovery.
 *
 * Both builders use the {@link ConnectionPool} for connection reuse,
 * avoiding repeated ML-DSA-65 handshakes on subsequent calls.
 *
 * @packageDocumentation
 */

// NOTE: This is a pre-build scaffolding stub. All method bodies throw
// `Error('Not implemented')`. The real implementation will follow
// TS_PHASE_4_CLIENT.md §4 and mirror the Rust
// `aafp-sdk/src/simple.rs` DiscoveryBuilder/DirectCallBuilder.

import type { ConnectionPool } from "./pool.ts";
import type { AgentId, AafpError, Request, Response } from "./types.ts";

// ─── CallOptions ──────────────────────────────────────────────────

/**
 * Options for an RPC call (v2: cancellation + deadline + tracing).
 *
 * Passed to `DiscoveryBuilder.call()` and `DirectCallBuilder.call()`.
 */
export interface CallOptions {
  /** Abort signal for cancelling the in-flight RPC. */
  readonly signal?: AbortSignal;
  /** Request deadline (ISO 8601). Server may reject if exceeded. */
  readonly deadline?: string;
  /** Trace ID for distributed tracing. Propagated via `RequestMetadata`. */
  readonly traceId?: string;
}

// ─── FailoverLoop ─────────────────────────────────────────────────

/**
 * The result of a single iteration of the failover loop.
 *
 * Used internally by `DiscoveryBuilder` to track the outcome of each
 * candidate attempt. The loop continues until a `Success` is encountered
 * or all candidates are exhausted.
 */
export type FailoverStep =
  | { readonly kind: "success"; readonly response: Response }
  | { readonly kind: "failure"; readonly error: Error; readonly addr: string }
  | { readonly kind: "skip"; readonly reason: string };

/**
 * Configuration for the failover loop in `DiscoveryBuilder.call()`.
 *
 * Controls how many candidates are tried and how failures are handled.
 */
export interface FailoverLoopConfig {
  /**
   * Maximum number of candidates to try before giving up.
   * Default: all candidates (no limit).
   */
  readonly maxAttempts?: number;
  /**
   * Delay between failover attempts in milliseconds.
   * Default: 0 (immediate retry).
   */
  readonly retryDelayMs?: number;
  /**
   * Whether to remove failed connections from the pool.
   * Default: `true` — dead connections should not be reused.
   */
  readonly removeFailedConnections?: boolean;
}

/**
 * Execute a failover loop over a list of candidate addresses.
 *
 * Tries each candidate in order, calling `attempt(addr)` for each. Returns
 * the first successful response, or throws the last error if all candidates
 * fail.
 *
 * On failure, the dead connection is removed from the pool via
 * `pool.remove(addr)` so subsequent calls don't reuse it.
 *
 * @typeParam T - The return type of a successful attempt.
 * @param candidates - Array of candidate addresses to try.
 * @param attempt - Async function called for each candidate.
 * @param config - Failover loop configuration.
 * @returns The first successful result.
 * @throws The last error if all candidates fail.
 */
export async function failoverLoop<T>(
  candidates: readonly string[],
  attempt: (addr: string) => Promise<T>,
  config?: FailoverLoopConfig,
): Promise<T> {
  throw new Error("Not implemented");
}

// ─── DiscoveryBuilder ─────────────────────────────────────────────

/**
 * Builder for discovering and calling agents by capability (v2).
 *
 * On `call()`, loops through **all** candidates with failover — if the
 * first candidate fails (connection error, handshake error, RPC error),
 * tries the next, until one succeeds or all fail.
 *
 * This is critical for resilience: if one agent is down, the call
 * transparently retries the next.
 *
 * @example
 * ```typescript
 * const result = await agent.discover("echo")
 *   .call(Request.text("hello"));
 * ```
 *
 * @example With cancellation:
 * ```typescript
 * const ctrl = new AbortController();
 * const result = await agent.discover("echo")
 *   .call(Request.text("hello"), { signal: ctrl.signal });
 * ```
 */
export class DiscoveryBuilder {
  /**
   * @param client - The internal AAFP client engine (DHT lookups, RPC).
   * @param pool - The connection pool for connection reuse.
   * @param capability - The capability name to discover.
   */
  constructor(
    private readonly client: unknown,
    private readonly pool: ConnectionPool,
    private readonly capability: string,
  ) {
    throw new Error("Not implemented");
  }

  /**
   * Discover an agent with this capability and call it.
   *
   * Failover: tries each candidate in order. Returns the first successful
   * response, or throws the **last** error if all candidates fail (so the
   * caller sees the most recent failure reason).
   *
   * On failure, the dead connection is removed from the pool via
   * `pool.remove(addr)` so the next candidate doesn't reuse it.
   *
   * @param request - The request to send.
   * @param opts - Optional call options (cancellation, deadline, tracing).
   * @returns The first successful response.
   * @throws {AafpError} If no agents are found for the capability.
   * @throws {Error} The last error if all candidates fail.
   */
  async call(request: Request, opts?: CallOptions): Promise<Response> {
    throw new Error("Not implemented");
  }

  /**
   * Discover an agent and start a server-streaming call (v2).
   *
   * Returns an `AsyncIterable<Response>` — use
   * `for await (const chunk of stream)`.
   *
   * **NOTE:** Streaming does NOT failover mid-stream. We pick the first
   * reachable candidate. If it fails before the stream opens, we failover
   * to the next. Once the stream is open, errors propagate to the consumer.
   *
   * @param request - The request to send.
   * @param opts - Optional call options (cancellation, deadline, tracing).
   * @returns An async iterable of response chunks.
   * @throws {AafpError} If no agents are found or all candidates fail to
   *   open a stream.
   */
  async callStreaming(
    request: Request,
    opts?: CallOptions,
  ): Promise<AsyncIterable<Response>> {
    throw new Error("Not implemented");
  }
}

// ─── DirectCallBuilder ────────────────────────────────────────────

/**
 * Builder for calling a specific agent by its AgentId (v2).
 *
 * Looks up the agent's record in the DHT, then calls it directly. Uses
 * the connection pool for reuse.
 *
 * @example
 * ```typescript
 * const result = await agent.discoverById(targetAgentId)
 *   .call(Request.text("hello"));
 * ```
 */
export class DirectCallBuilder {
  /**
   * @param client - The internal AAFP client engine (DHT lookups, RPC).
   * @param pool - The connection pool for connection reuse.
   * @param agentId - The AgentId of the specific agent to call.
   */
  constructor(
    private readonly client: unknown,
    private readonly pool: ConnectionPool,
    private readonly agentId: AgentId,
  ) {
    throw new Error("Not implemented");
  }

  /**
   * Call the specific agent identified by `agentId`.
   *
   * Looks up the agent's record in the DHT, dials its first endpoint (using
   * the pool for reuse), and sends the RPC request.
   *
   * @param request - The request to send.
   * @param opts - Optional call options (cancellation, deadline, tracing).
   * @returns The agent's response.
   * @throws {AafpError} If the agent is not found in the DHT or has no
   *   endpoints.
   * @throws {Error} If the RPC call fails (the dead connection is removed
   *   from the pool).
   */
  async call(request: Request, opts?: CallOptions): Promise<Response> {
    throw new Error("Not implemented");
  }
}
