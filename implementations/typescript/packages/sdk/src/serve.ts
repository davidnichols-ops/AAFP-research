/**
 * ServeBuilder and ServingAgent — the server-side entry point.
 *
 * The `ServeBuilder` is a chainable builder that collects capabilities,
 * per-capability handlers, streaming handlers, bidirectional handlers,
 * a deprecated v1 fallback handler, bind address, keypair, metrics
 * address, and transport factory. The `.start()` method assembles
 * everything into a server and returns a `ServingAgent`.
 *
 * @module serve
 */

import type {
  CapabilityHandler,
  StreamingHandler,
  BidirectionalHandler,
  LegacyHandler,
} from "./handler.js";
import type { AgentKeypair } from "./handshake.js";

// ─── Placeholder types (to be replaced by real implementations) ──

/**
 * Agent identifier placeholder.
 * Will be replaced by the real `AgentId` type from the identity module.
 */
export type AgentId = string;

/**
 * Multiaddr placeholder.
 * Will be replaced by the real `Multiaddr` type from the transport module.
 */
export type Multiaddr = string;

/**
 * Agent record placeholder.
 * Will be replaced by the real `AgentRecord` type from the identity module.
 */
export interface AgentRecord {
  /** Agent identifier. */
  agentId: AgentId;
  /** List of endpoint addresses. */
  endpoints: Multiaddr[];
  /** Capabilities provided by this agent. */
  capabilities: string[];
  /** Agent public key. */
  publicKey: Uint8Array;
}

/**
 * Transport factory placeholder.
 * Will be replaced by the real `TransportFactory` type from the transport module.
 */
export interface TransportFactory {
  /**
   * Create a transport instance.
   * @param opts - Transport creation options.
   * @returns A transport instance.
   */
  create(opts: {
    role: "server" | "client";
    bindAddr?: string;
    keypair: AgentKeypair;
  }): Promise<Transport>;
}

/**
 * Transport placeholder.
 * Will be replaced by the real `Transport` type from the transport module.
 */
export interface Transport {
  /** Local address the transport is bound to. */
  readonly localAddr: Multiaddr;
  /**
   * Accept an incoming connection.
   * @returns A new connection.
   */
  accept(): Promise<Connection>;
  /** Close the transport. */
  close(): Promise<void>;
}

/**
 * Connection placeholder.
 * Will be replaced by the real `Connection` type from the transport module.
 */
export interface Connection {
  /** Accept a bidirectional stream. */
  acceptBidiStream(): Promise<BidiStream>;
  /** Close the connection. */
  close(): Promise<void>;
}

/**
 * Bidirectional stream placeholder.
 * Will be replaced by the real `BidiStream` type from the transport module.
 */
export interface BidiStream {
  /** Read data from the stream. Returns null on EOF. */
  read(): Promise<Uint8Array | null>;
  /** Write data to the stream. */
  write(data: Uint8Array): Promise<void>;
  /** Signal that the write side is finished. */
  finish(): Promise<void>;
}

/**
 * Connection pool configuration placeholder.
 * Will be replaced by the real `PoolConfig` type from the connection pool module.
 */
export interface PoolConfig {
  /** Maximum number of pooled connections. */
  maxConnections?: number;
  /** Idle timeout in milliseconds. */
  idleTimeoutMs?: number;
}

// ─── ServeOptions ───────────────────────────────────────────────

/**
 * Options assembled by the {@link ServeBuilder}.
 *
 * Contains all configuration needed to start a serving agent.
 */
export interface ServeOptions {
  /** Capabilities this agent provides. */
  capabilities: string[];
  /** Per-capability unary handlers (v2). */
  capabilityHandlers: Map<string, CapabilityHandler>;
  /** Per-capability server-streaming handlers (v2). */
  streamingHandlers: Map<string, StreamingHandler>;
  /** Per-capability bidirectional streaming handlers (v2). */
  bidiHandlers: Map<string, BidirectionalHandler>;
  /** Fallback handler for all capabilities (v1 compat). */
  fallbackHandler: LegacyHandler | null;
  /** Bind address (default: random port, 0.0.0.0:0). */
  bindAddr?: string;
  /** Agent keypair (default: auto-generated). */
  keypair?: AgentKeypair;
  /** Prometheus metrics endpoint address. */
  metricsAddr?: string;
  /** Transport factory (default: auto-detect). */
  transport?: TransportFactory;
  /** Connection pooling configuration for outgoing calls (v2). */
  poolConfig?: PoolConfig;
}

// ─── ServeBuilder ───────────────────────────────────────────────

/**
 * Chainable builder for serving an agent.
 *
 * Supports both v1 (single `handler()`) and v2 (`onCapability()`) APIs.
 * Call `.start()` to build and start the agent.
 *
 * @example
 * ```typescript
 * const server = await new ServeBuilder()
 *   .capability("echo")
 *   .onCapability("echo", async (req, ctx) => {
 *     return Response.text(req.body);
 *   })
 *   .withMetrics("0.0.0.0:9090")
 *   .start();
 * ```
 */
export class ServeBuilder {
  /** Internal options being assembled. */
  private opts: ServeOptions = {
    capabilities: [],
    capabilityHandlers: new Map(),
    streamingHandlers: new Map(),
    bidiHandlers: new Map(),
    fallbackHandler: null,
  };

  /**
   * Add a capability this agent provides.
   * @param cap - The capability name.
   * @returns `this` for chaining.
   */
  capability(cap: string): this {
    throw new Error("Not implemented");
  }

  /**
   * Register a handler for a specific capability (v2).
   *
   * The handler receives a {@link Request} and a `HandlerContext` with
   * cancellation and capability info. Multiple capabilities can have
   * different handlers.
   * @param cap - The capability name.
   * @param handler - The handler function.
   * @returns `this` for chaining.
   */
  onCapability(cap: string, handler: CapabilityHandler): this {
    throw new Error("Not implemented");
  }

  /**
   * Register a server-streaming handler (v2).
   *
   * The handler receives a {@link Request} and a `StreamingHandlerContext`
   * with a `send()` method for streaming multiple response frames to the
   * client.
   * @param cap - The capability name.
   * @param handler - The streaming handler function.
   * @returns `this` for chaining.
   */
  onStreaming(cap: string, handler: StreamingHandler): this {
    throw new Error("Not implemented");
  }

  /**
   * Register a bidirectional streaming handler (v2).
   *
   * The handler receives an `AsyncIterable<Request>` and a
   * `StreamingHandlerContext`.
   * @param cap - The capability name.
   * @param handler - The bidirectional handler function.
   * @returns `this` for chaining.
   */
  onBidirectional(cap: string, handler: BidirectionalHandler): this {
    throw new Error("Not implemented");
  }

  /**
   * Set a fallback handler for all capabilities (v1 compat mode).
   * @param fn - The legacy handler function.
   * @returns `this` for chaining.
   * @deprecated Use `onCapability()` for per-capability routing.
   */
  handler(fn: LegacyHandler): this {
    throw new Error("Not implemented");
  }

  /**
   * Set the bind address (default: random port, 0.0.0.0:0).
   * @param addr - The bind address in `host:port` format.
   * @returns `this` for chaining.
   */
  bind(addr: string): this {
    throw new Error("Not implemented");
  }

  /**
   * Set the agent's keypair (default: auto-generated).
   * @param kp - The agent keypair.
   * @returns `this` for chaining.
   */
  withKeypair(kp: AgentKeypair): this {
    throw new Error("Not implemented");
  }

  /**
   * Enable Prometheus metrics endpoint.
   * @param addr - The metrics server bind address in `host:port` format.
   * @returns `this` for chaining.
   */
  withMetrics(addr: string): this {
    throw new Error("Not implemented");
  }

  /**
   * Explicitly choose a transport (default: auto-detect).
   * @param factory - The transport factory.
   * @returns `this` for chaining.
   */
  withTransport(factory: TransportFactory): this {
    throw new Error("Not implemented");
  }

  /**
   * Configure connection pooling for outgoing calls (v2).
   * @param config - The pool configuration.
   * @returns `this` for chaining.
   */
  withConnectionPool(config: PoolConfig): this {
    throw new Error("Not implemented");
  }

  /**
   * Build and start the agent. Resolves when serving.
   * @returns A {@link ServingAgent} instance.
   */
  async start(): Promise<ServingAgent> {
    throw new Error("Not implemented");
  }
}

// ─── ServingAgent ───────────────────────────────────────────────

/**
 * A running serving agent.
 *
 * Returned by {@link ServeBuilder.start}. Provides access to the agent's
 * ID, address, capabilities, and agent record. Call `stop()` to shut
 * down the agent.
 *
 * @example
 * ```typescript
 * const agent = await builder.start();
 * console.log(`Serving on ${agent.addr} (id: ${agent.id})`);
 * // ... serve ...
 * await agent.stop();
 * ```
 */
export class ServingAgent {
  /**
   * @param ctx - Internal context with server, agent ID, address, keypair, and capabilities.
   */
  constructor(
    private readonly ctx: {
      /** The underlying server instance. */
      server: unknown;
      /** Agent identifier. */
      agentId: AgentId;
      /** Bound multiaddr. */
      addr: Multiaddr;
      /** Agent keypair. */
      keypair: AgentKeypair;
      /** Capabilities provided. */
      capabilities: string[];
    },
  ) {}

  /** Agent identifier. */
  get id(): AgentId {
    throw new Error("Not implemented");
  }

  /** Bound multiaddr. */
  get addr(): Multiaddr {
    throw new Error("Not implemented");
  }

  /** Capabilities provided by this agent. */
  get capabilities(): readonly string[] {
    throw new Error("Not implemented");
  }

  /** Agent record (for DHT registration). */
  get record(): AgentRecord {
    throw new Error("Not implemented");
  }

  /**
   * Stop the serving agent and release all resources.
   */
  async stop(): Promise<void> {
    throw new Error("Not implemented");
  }

  /**
   * Async disposal — equivalent to calling `stop()`.
   *
   * Enables `await using` syntax (explicit-resource-management).
   */
  [Symbol.asyncDispose](): Promise<void> {
    throw new Error("Not implemented");
  }
}
