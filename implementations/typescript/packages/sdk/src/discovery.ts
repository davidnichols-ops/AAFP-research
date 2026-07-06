/**
 * @aafp/sdk — Discovery and direct-call builders for the v2 client API.
 *
 * The `DiscoveryBuilder` discovers agents by capability and calls them with
 * failover across all candidates. The `DirectCallBuilder` calls a specific
 * agent by its AgentId, bypassing capability-based discovery.
 *
 * @packageDocumentation
 */

import type { ConnectionPool } from "./pool.js";
import type { AgentId, AgentRecord, Request, Response, Multiaddr } from "./types.js";

// ─── CallOptions ──────────────────────────────────────────────────

export interface CallOptions {
  readonly signal?: AbortSignal;
  readonly deadline?: string;
  readonly traceId?: string;
}

// ─── FailoverLoopConfig ───────────────────────────────────────────

export interface FailoverLoopConfig {
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  readonly removeFailedConnections?: boolean;
}

/**
 * Execute a failover loop over a list of candidate addresses.
 *
 * Tries each candidate in order. Returns the first successful result,
 * or throws the last error if all candidates fail.
 */
export async function failoverLoop<T>(
  candidates: readonly string[],
  attempt: (addr: string) => Promise<T>,
  config?: FailoverLoopConfig,
): Promise<T> {
  const max = config?.maxAttempts ?? candidates.length;
  const delay = config?.retryDelayMs ?? 0;
  let lastError: Error | null = null;

  for (let i = 0; i < Math.min(max, candidates.length); i++) {
    const addr = candidates[i]!;
    try {
      return await attempt(addr);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (delay > 0 && i < max - 1) {
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError ?? new Error("no candidates available");
}

// ─── Client context (shared with ConnectedAgent) ──────────────────

export interface ClientContext {
  readonly client: unknown;
  readonly agentId: AgentId;
  readonly pool: ConnectionPool;
}

// ─── DiscoveryBuilder ─────────────────────────────────────────────

/**
 * Builder for discovering and calling agents by capability (v2).
 *
 * On `call()`, loops through all candidates with failover.
 */
export class DiscoveryBuilderImpl {
  constructor(
    private readonly ctx: ClientContext,
    private readonly capability: string,
  ) {}

  /**
   * Discover an agent with this capability and call it.
   * Failover: tries each candidate in order.
   */
  async call(request: Request, opts?: CallOptions): Promise<Response> {
    // In a full implementation, this would query the DHT for agents
    // providing this capability, then failover across them.
    // For now, throw to indicate no DHT is available.
    throw new Error(
      `discovery not yet implemented (capability=${this.capability})`,
    );
  }

  /**
   * Discover an agent and start a server-streaming call (v2).
   */
  async callStreaming(
    request: Request,
    opts?: CallOptions,
  ): Promise<AsyncIterable<Response>> {
    throw new Error(
      `streaming discovery not yet implemented (capability=${this.capability})`,
    );
  }
}

// Re-export with the expected name
export type DiscoveryBuilder = DiscoveryBuilderImpl;

// ─── DirectCallBuilder ────────────────────────────────────────────

/**
 * Builder for calling a specific agent by its AgentId (v2).
 */
export class DirectCallBuilderImpl {
  constructor(
    private readonly ctx: ClientContext,
    private readonly agentId: AgentId,
  ) {}

  /**
   * Call the specific agent identified by `agentId`.
   */
  async call(request: Request, opts?: CallOptions): Promise<Response> {
    const record = this.ctx.pool.getRecord(this.agentId);
    if (!record) {
      throw new Error(`agent not found: ${this.agentId}`);
    }
    if (record.endpoints.length === 0) {
      throw new Error(`agent has no endpoints: ${this.agentId}`);
    }
    // In a full implementation, this would dial the endpoint and send RPC.
    throw new Error(
      `direct call not yet implemented (agent=${this.agentId}, addr=${record.endpoints[0]})`,
    );
  }
}

// Re-export with the expected name
export type DirectCallBuilder = DirectCallBuilderImpl;
