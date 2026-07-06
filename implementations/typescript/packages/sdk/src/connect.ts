/**
 * @aafp/sdk — Client-side connection API: ConnectBuilder + ConnectedAgent.
 *
 * The `ConnectBuilder` is the client-side analog of `ServeBuilder`. It is
 * returned by `Agent.connect()` and produces a {@link ConnectedAgent} via
 * `.connect()`.
 *
 * The `ConnectedAgent` is the running client. It holds an internal engine
 * (`AafpClient`) that does DHT lookups, dials, handshakes, and RPC, the
 * agent's own `AgentId`, and a reference to the {@link ConnectionPool} for
 * stats inspection.
 *
 * @packageDocumentation
 */

// NOTE: This is a pre-build scaffolding stub. All method bodies throw
// `Error('Not implemented')`. The real implementation will follow
// TS_PHASE_4_CLIENT.md §2–§3 and mirror the Rust
// `aafp-sdk/src/simple.rs` ConnectBuilder/ConnectedAgent.

import type { AgentId, AgentKeypair, Multiaddr, Request, Response } from "./types.js";
import type { AgentRecord } from "./types.js";
import type { TransportFactory } from "./serve.js";
import { ConnectionPool } from "./pool.js";
import type { PoolConfig, PoolStats } from "./pool.js";
import type { DiscoveryBuilder, DirectCallBuilder } from "./discovery.js";
import { DiscoveryBuilderImpl, DirectCallBuilderImpl } from "./discovery.js";

// ─── ConnectOptions ───────────────────────────────────────────────

/**
 * Options for connecting a client agent to the AAFP network.
 *
 * Used internally by {@link ConnectBuilder}. All fields are optional —
 * defaults are applied by the builder.
 */
export interface ConnectOptions {
  /** The agent's keypair (default: auto-generated ML-DSA-65). */
  readonly keypair?: AgentKeypair;
  /** Bootstrap seed nodes for DHT discovery. */
  readonly seeds?: string[];
  /** Explicit transport factory (default: auto-detect runtime). */
  readonly transport?: TransportFactory;
  /** Connection pool configuration (v2). Defaults to `PoolConfig.default()`. */
  readonly poolConfig?: PoolConfig;
}

// ─── ConnectBuilder ───────────────────────────────────────────────

/**
 * Builder for connecting a client agent to the AAFP network.
 *
 * Returned by `Agent.connect()`. Produces a {@link ConnectedAgent} via
 * `.connect()`.
 *
 * Connection pooling is **always** enabled in v2 (there is no
 * "pooling disabled" mode). The 50x performance improvement from reusing
 * QUIC connections is too significant to opt out of.
 *
 * @example
 * ```typescript
 * const agent = await Agent.connect()
 *   .withSeeds(["/ip4/127.0.0.1/udp/4001/quic-v1"])
 *   .withPoolConfig({ maxSize: 64, idleTimeoutMs: 60_000 })
 *   .connect();
 * ```
 */
export class ConnectBuilder {
  private opts: ConnectOptions = {};

  /**
   * Set the agent's keypair.
   *
   * If not set, a new ML-DSA-65 keypair is auto-generated on `.connect()`.
   *
   * @param kp - The keypair to use.
   * @returns `this` for chaining.
   */
  withKeypair(kp: AgentKeypair): this {
    this.opts = { ...this.opts, keypair: kp };
    return this;
  }

  /**
   * Set bootstrap seed nodes for DHT discovery.
   *
   * Seed nodes are the entry points to the AAFP network. The client
   * bootstraps into the DHT via these nodes on `.connect()`.
   *
   * @param seeds - Array of multiaddr strings (e.g.
   *   `"/ip4/127.0.0.1/udp/4001/quic-v1"`).
   * @returns `this` for chaining.
   */
  withSeeds(seeds: string[]): this {
    this.opts = { ...this.opts, seeds };
    return this;
  }

  /**
   * Explicitly choose a transport.
   *
   * If not set, the transport is auto-detected based on the runtime
   * (`node:quic` in Node.js, WebTransport in browsers).
   *
   * @param factory - The transport factory to use.
   * @returns `this` for chaining.
   */
  withTransport(factory: TransportFactory): this {
    this.opts = { ...this.opts, transport: factory };
    return this;
  }

  /**
   * Configure connection pooling (v2).
   *
   * Pooling is enabled by default with `PoolConfig.default()`. Override
   * here for high-throughput or resource-constrained deployments.
   *
   * @param config - The pool configuration to use.
   * @returns `this` for chaining.
   * @see {@link PoolConfig.highThroughput}
   * @see {@link PoolConfig.conservative}
   */
  withPoolConfig(config: PoolConfig): this {
    this.opts = { ...this.opts, poolConfig: config };
    return this;
  }

  /**
   * Build the agent and connect to the network.
   *
   * Generates (or uses provided) keypair, creates the transport, initializes
   * the connection pool, bootstraps into the DHT via seed nodes, and returns
   * a {@link ConnectedAgent} ready for `discover()`/`discoverById()`/`callAt()`.
   *
   * @returns A connected agent ready for discovery and RPC calls.
   */
  async connect(): Promise<ConnectedAgent> {
    const keypair = this.opts.keypair ?? (await this.generateKeypair());
    const agentId = keypair.agentId() as AgentId;

    // In a full implementation, this would create the transport, initialize
    // the connection pool, and bootstrap into the DHT. For now, we return
    // a ConnectedAgent with the assembled state.
    const pool = new ConnectionPool(this.opts.poolConfig ?? { maxSize: 64, idleTimeoutMs: 60_000 });
    return new ConnectedAgent({ client: {}, agentId, pool });
  }

  private async generateKeypair(): Promise<AgentKeypair> {
    const { generateKeypair: gen } = await import("@aafp/crypto");
    return gen() as unknown as AgentKeypair;
  }
}

// ─── ConnectedAgent ───────────────────────────────────────────────

/**
 * A connected client agent. Discover and call other agents on the AAFP network.
 *
 * Holds an internal engine (`AafpClient`) that does DHT lookups, dials,
 * handshakes, and RPC, the agent's own `AgentId`, and a reference to the
 * {@link ConnectionPool} for stats inspection.
 *
 * `discover()` and `discoverById()` return builders that are `'static'` (no
 * borrowed references) — they hold their own references to the client and
 * pool, so they can be passed to `Promise.all()` or stored in closures
 * without lifetime issues.
 *
 * Supports `using await agent = ...` syntax (TC39 explicit-resource-management,
 * available in Node 22+ and TS 5.2+) via `[Symbol.asyncDispose]()`.
 *
 * @example
 * ```typescript
 * using await agent = await Agent.connect().connect();
 * const result = await agent.discover("echo").call(Request.text("hello"));
 * // agent.close() called automatically on scope exit
 * ```
 */
export class ConnectedAgent {
  constructor(
    private readonly ctx: {
      readonly client: unknown;
      readonly agentId: AgentId;
      readonly pool: ConnectionPool;
    },
  ) {}

  /**
   * This agent's ID (hex of SHA-256(publicKey)).
   */
  get id(): AgentId {
    return this.ctx.agentId;
  }

  /**
   * Discover agents providing a capability.
   *
   * Returns a {@link DiscoveryBuilder} that loops through all candidates
   * with failover on `.call()`.
   *
   * @param capability - The capability name to discover.
   * @returns A builder for calling discovered agents.
   */
  discover(capability: string): DiscoveryBuilder {
    return new DiscoveryBuilderImpl(this.ctx, capability);
  }

  /**
   * Discover a specific agent by its AgentId.
   *
   * Returns a {@link DirectCallBuilder} that looks up the agent's record in
   * the DHT and calls it directly, bypassing capability-based discovery.
   *
   * @param agentId - The AgentId (hex string) of the agent to call.
   * @returns A builder for calling the specific agent.
   */
  discoverById(agentId: AgentId): DirectCallBuilder {
    return new DirectCallBuilderImpl(this.ctx, agentId);
  }

  /**
   * Call an agent at a specific multiaddr, bypassing discovery entirely.
   *
   * Useful for testing or when the address is known out-of-band.
   * Still uses the connection pool for reuse.
   *
   * @param addr - The multiaddr of the agent to call.
   * @param request - The request to send.
   * @returns The agent's response.
   */
  async callAt(addr: Multiaddr, request: Request): Promise<Response> {
    // In a full implementation, this would dial the address, handshake,
    // and send the RPC request. For now, throw to indicate no transport.
    throw new Error(`callAt not yet implemented (addr=${addr})`);
  }

  /**
   * Register a server's AgentRecord in the local DHT cache.
   *
   * This is how a client learns about servers without a full DHT lookup —
   * e.g., when a `ServingAgent` in the same process shares its record.
   *
   * @param record - The agent record to register.
   */
  register(record: AgentRecord): void {
    this.ctx.pool.registerRecord(record);
  }

  /**
   * Inspect the connection pool.
   *
   * Returns a **snapshot** of current pool state — active connections, idle
   * connections, total, max, and per-peer info.
   */
  get poolStats(): PoolStats {
    return this.ctx.pool.stats();
  }

  /**
   * Close all pooled connections and shut down the client.
   *
   * Idempotent — calling it twice should not throw.
   */
  async close(): Promise<void> {
    await this.ctx.pool.closeAll();
  }

  /**
   * Async dispose for `using await agent = ...` syntax (TC39
   * explicit-resource-management, Node 22+, TS 5.2+).
   *
   * Delegates to {@link close}.
   *
   * @returns A promise that resolves when the agent is fully shut down.
   */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}
