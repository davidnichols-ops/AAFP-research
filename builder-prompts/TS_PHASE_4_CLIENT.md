# TypeScript SDK — Phase 4: v2 Client-side API + Connection Pooling

**Builder Prompt**
**Date:** 2026-07-05
**Project:** AAFP (Agent-to-Agent Framing Protocol)
**Target:** `@aafp/sdk` (pure-TypeScript SDK)
**Phase:** 4 of the TS SDK implementation plan

---

## 0. Objective

Implement the **v2 client-side API** for the pure-TypeScript AAFP SDK. This phase
delivers the developer-facing surface that lets a caller discover agents by
capability, call them with structured requests, reuse pooled QUIC connections
(avoiding repeated ML-DSA-65 handshakes), and inspect pool health — all with
idiomatic TypeScript async/await and async iterables.

This phase builds on Phase 3 (server-side: `ServeBuilder`, `ServingAgent`,
per-capability handlers, streaming). The shared types (`Request`, `Response`,
`Params`, `RequestMetadata`, `ResponseMetadata`, `HandlerContext`,
`HandlerError`) from Phase 1 are reused unchanged.

**Deliverables:**

1. `ConnectBuilder` — chainable builder with `.withPoolConfig()`, `.connect()`.
2. `ConnectedAgent` — running client with `.discover()`, `.discoverById()`,
   `.callAt()`, `.register()`, `.poolStats`.
3. `DiscoveryBuilder` — `.call()` with failover across all candidates,
   `.callStreaming()` for server-streaming RPC.
4. `DirectCallBuilder` — `.call()` for a specific agent by ID.
5. `ConnectionPool` — `PoolConfig`, `PooledConnection`, health checks, LRU
   eviction, `PoolStats` inspection.
6. `HandshakeDriver` (client side) — the v1 handshake state machine in
   TypeScript, transport-agnostic.
7. Session ID derivation — HKDF from the handshake transcript.

**Design sources:**
- `TYPESCRIPT_SDK_DESIGN.md` §5.4 (ConnectBuilder/ConnectedAgent), §5.5
  (DiscoveryBuilder/DirectCallBuilder), §5.6 (ConnectionPool), §7.4
  (HandshakeDriver).
- `SESSION_AFFINITY_DESIGN.md` §1–§5 (pool design, session ID derivation,
  health checks, eviction, PoolStats).
- `SIMPLE_API_V2_DESIGN.md` §4 (session affinity + connection reuse), §9
  (discovery failover + discoverById).

---

## 1. Context: What Phases 1–3 Delivered

Phase 1 delivered the shared v2 types in `src/types.ts`:
- `Params` (CBOR IntMap with `putStr`/`putU64`/`getStr`/`getU64`/`toCbor`).
- `Request` / `Response` (params + text + binary + metadata, with `text()` /
  `data()` / `withParams()` / `withResult()` static constructors and
  `withMetadata()` callback).
- `RequestMetadata` / `ResponseMetadata` interfaces.
- `HandlerContext` (AbortSignal + capability), `HandlerError` +
  `HandlerErrorCategory` (RFC-0005 typed errors).
- `CapabilityHandler`, `StreamingHandler`, `BidirectionalHandler`,
  `LegacyHandler` type aliases.
- `AgentId` (hex string), `Multiaddr` (string), `AafpError` + `AafpErrorCode`.

Phase 2 delivered the transport abstraction in `src/transport/`:
- `Transport` interface (`dial`, `accept`, `close`).
- `BidiStream` interface (`send.write()`, `recv.read()`, `finish()`).
- `TransportFactory` + `defaultTransportFactory` (auto-detects `node:quic` vs
  WebTransport).
- `Connection` interface wrapping a transport-level connection with
  `openBidi()`, `close()`, `closed`.

Phase 3 delivered the server side in `src/serve.ts` + `src/server.ts`:
- `ServeBuilder` with `.capability()`, `.onCapability()`, `.onStreaming()`,
  `.onBidirectional()`, `.handler()` (deprecated v1), `.bind()`,
  `.withKeypair()`, `.withMetrics()`, `.withTransport()`,
  `.withConnectionPool()`, `.start()`.
- `ServingAgent` with `.id`, `.addr`, `.capabilities`, `.record`, `.stop()`.
- `AafpServer` — the accept loop, handshake, frame decode, handler dispatch,
  streaming forwarder.

Phase 4 now fills in the **client half**: `ConnectBuilder`, `ConnectedAgent`,
`DiscoveryBuilder`, `DirectCallBuilder`, `ConnectionPool`, and the client-side
`HandshakeDriver`.

---

## 2. ConnectBuilder

**File:** `src/connect.ts`

The `ConnectBuilder` is the client-side analog of `ServeBuilder`. It is
returned by `Agent.connect()` and produces a `ConnectedAgent` via `.connect()`.

### 2.1 Design

```typescript
// src/connect.ts

import { AgentKeypair, generateKeypair, AgentId, Multiaddr } from "./types.ts";
import { TransportFactory, defaultTransportFactory } from "./transport/interface.ts";
import { ConnectionPool, PoolConfig } from "./pool.ts";
import { AafpClient } from "./client.ts";
import { DiscoveryBuilder } from "./discovery.ts";
import { DirectCallBuilder } from "./discovery.ts";
import { Request, Response, AgentRecord } from "./types.ts";

export interface ConnectOptions {
  keypair?: AgentKeypair;
  seeds?: string[];
  transport?: TransportFactory;
  /** Connection pool configuration (v2). Defaults to PoolConfig.default(). */
  poolConfig?: PoolConfig;
}

/**
 * Builder for connecting a client agent to the AAFP network.
 *
 * Usage:
 *   const agent = await Agent.connect()
 *     .withSeeds(["/ip4/127.0.0.1/udp/4001/quic-v1"])
 *     .withPoolConfig({ maxSize: 64, idleTimeoutMs: 60_000 })
 *     .connect();
 */
export class ConnectBuilder {
  private opts: ConnectOptions = {};

  /** Set the agent's keypair (default: auto-generated ML-DSA-65). */
  withKeypair(kp: AgentKeypair): this {
    this.opts.keypair = kp;
    return this;
  }

  /** Set bootstrap seed nodes for DHT discovery. */
  withSeeds(seeds: string[]): this {
    this.opts.seeds = seeds;
    return this;
  }

  /** Explicitly choose a transport (default: auto-detect runtime). */
  withTransport(factory: TransportFactory): this {
    this.opts.transport = factory;
    return this;
  }

  /**
   * Configure connection pooling (v2).
   * Pooling is enabled by default with PoolConfig.default(). Override here
   * for high-throughput or resource-constrained deployments.
   */
  withPoolConfig(config: PoolConfig): this {
    this.opts.poolConfig = config;
    return this;
  }

  /**
   * Build the agent and connect to the network.
   * Generates (or uses provided) keypair, creates the transport, initializes
   * the connection pool, bootstraps into the DHT via seed nodes, and returns
   * a ConnectedAgent ready for discover()/discoverById()/callAt().
   */
  async connect(): Promise<ConnectedAgent> {
    const keypair = this.opts.keypair ?? await generateKeypair();
    const transport = await (this.opts.transport ?? defaultTransportFactory)
      .create({ role: "client", keypair });

    const pool = new ConnectionPool(
      this.opts.poolConfig ?? PoolConfig.default(),
      transport,
      keypair,
    );

    const client = new AafpClient({
      transport,
      keypair,
      seeds: this.opts.seeds ?? [],
      pool,
    });
    await client.bootstrap();

    return new ConnectedAgent({ client, agentId: keypair.agentId(), pool });
  }
}
```

### 2.2 Requirements

- `.connect()` MUST resolve only after the DHT bootstrap is complete (or
  attempted — bootstrap failure should not block if seeds are unreachable, but
  should log a warning; discovery will fail later if no peers are known).
- The pool is always created (even with default config) — there is no
  "pooling disabled" mode in v2. This is a deliberate change from v1, which
  always dialed fresh. The 50x perf improvement is too significant to opt out
  of.
- `AgentKeypair` generation uses `@noble/post-quantum` ML-DSA-65 (from Phase 1).

---

## 3. ConnectedAgent

**File:** `src/connect.ts` (continued)

The `ConnectedAgent` is the running client. It holds an `AafpClient` (the
internal engine that does DHT lookups, dials, handshakes, and RPC), the
agent's own `AgentId`, and a reference to the `ConnectionPool` for stats
inspection.

### 3.1 Design

```typescript
/**
 * A connected client agent. Discover and call other agents on the AAFP network.
 */
export class ConnectedAgent {
  constructor(
    private readonly ctx: {
      client: AafpClient;
      agentId: AgentId;
      pool: ConnectionPool;
    },
  ) {}

  /** This agent's ID (hex of SHA-256(publicKey)). */
  get id(): AgentId {
    return this.ctx.agentId;
  }

  /**
   * Discover agents providing a capability. Returns a DiscoveryBuilder that
   * loops through all candidates with failover on .call().
   */
  discover(capability: string): DiscoveryBuilder {
    return new DiscoveryBuilder(this.ctx.client, this.ctx.pool, capability);
  }

  /**
   * Discover a specific agent by its AgentId. Returns a DirectCallBuilder
   * that looks up the agent's record in the DHT and calls it directly,
   * bypassing capability-based discovery.
   */
  discoverById(agentId: AgentId): DirectCallBuilder {
    return new DirectCallBuilder(this.ctx.client, this.ctx.pool, agentId);
  }

  /**
   * Call an agent at a specific multiaddr, bypassing discovery entirely.
   * Useful for testing or when the address is known out-of-band.
   * Still uses the connection pool for reuse.
   */
  async callAt(addr: Multiaddr, request: Request): Promise<Response> {
    return this.ctx.client.callAt(addr, request);
  }

  /**
   * Register a server's AgentRecord in the local DHT cache.
   * This is how a client learns about servers without a full DHT lookup —
   * e.g., when a ServingAgent in the same process shares its record.
   */
  register(record: AgentRecord): void {
    this.ctx.client.register(record);
  }

  /**
   * Inspect the connection pool. Returns a snapshot of current pool state
   * — active connections, idle connections, total, max, and per-peer info.
   * See §6 for PoolStats.
   */
  get poolStats(): PoolStats {
    return this.ctx.pool.stats;
  }

  /** Close all pooled connections and shut down the client. */
  async close(): Promise<void> {
    await this.ctx.pool.closeAll();
    await this.ctx.client.close();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}
```

### 3.2 Requirements

- `discover()` and `discoverById()` return builders that are `'static` (no
  borrowed references) — they hold their own references to the client and pool,
  so they can be passed to `Promise.all()` or stored in closures without
  lifetime issues. This mirrors the Rust v2 change from `&SdkAgent` to
  `Arc<SdkAgent>`.
- `poolStats` is a getter that returns a **snapshot** — it's not a live view.
  Callers poll it for monitoring dashboards.
- `close()` must be idempotent — calling it twice should not throw.
- `[Symbol.asyncDispose]()` enables `using await agent = ...` syntax (TC39
  explicit-resource-management, available in Node 22+ and TS 5.2+).

---

## 4. DiscoveryBuilder + DirectCallBuilder

**File:** `src/discovery.ts`

### 4.1 DiscoveryBuilder — failover across all candidates

The v1 `DiscoveryBuilder` only tried `candidates[0]`. The v2 builder loops
through **all** candidates, failing over on error. This is critical for
resilience: if one agent is down, the call transparently retries the next.

```typescript
// src/discovery.ts

import { AafpClient } from "./client.ts";
import { ConnectionPool } from "./pool.ts";
import { Request, Response, AgentId, AafpError, AafpErrorCode } from "./types.ts";

/** Options for an RPC call (v2: cancellation + deadline + tracing). */
export interface CallOptions {
  /** Abort signal for cancelling the in-flight RPC. */
  signal?: AbortSignal;
  /** Request deadline (ISO 8601). Server may reject if exceeded. */
  deadline?: string;
  /** Trace ID for distributed tracing. Propagated via RequestMetadata. */
  traceId?: string;
}

/**
 * Builder for discovering and calling agents by capability (v2).
 * On .call(), loops through ALL candidates with failover — if the first
 * candidate fails (connection error, handshake error, RPC error), tries
 * the next, until one succeeds or all fail.
 */
export class DiscoveryBuilder {
  constructor(
    private readonly client: AafpClient,
    private readonly pool: ConnectionPool,
    private readonly capability: string,
  ) {}

  /**
   * Discover an agent with this capability and call it.
   * Failover: tries each candidate in order. Returns the first successful
   * response, or throws the last error if all candidates fail.
   */
  async call(request: Request, opts?: CallOptions): Promise<Response> {
    const candidates = await this.client.findByCapability(this.capability);
    if (candidates.length === 0) {
      throw new AafpError(
        AafpErrorCode.NoAgentsFound,
        `no agents found for capability '${this.capability}'`,
      );
    }

    let lastError: Error | null = null;
    for (const peer of candidates) {
      const addr = peer.endpoints[0];
      if (!addr) continue;

      try {
        // Pool reuse: if we already have a connection to this addr,
        // skip the handshake (14µs vs 709µs). Otherwise dial+handshake.
        const conn = await this.pool.getOrConnect(addr);
        const response = await this.client.callOnConnection(
          conn,
          request,
          this.capability,
          opts,
        );
        // Release connection back to pool (updates lastUsed)
        this.pool.release(addr);
        return response;
      } catch (e) {
        lastError = e as Error;
        // Remove the failed connection from the pool so the next
        // candidate doesn't reuse a dead connection.
        this.pool.remove(addr);
        continue; // Failover to next candidate
      }
    }

    throw lastError ?? new AafpError(
      AafpErrorCode.DiscoveryFailed,
      `all ${candidates.length} candidates for '${this.capability}' failed`,
    );
  }

  /**
   * Discover an agent and start a server-streaming call (v2).
   * Returns an AsyncIterable<Response> — use `for await (const chunk of stream)`.
   *
   * NOTE: Streaming does NOT failover mid-stream. We pick the first reachable
   * candidate. If it fails before the stream opens, we failover to the next.
   * Once the stream is open, errors propagate to the consumer.
   */
  async callStreaming(
    request: Request,
    opts?: CallOptions,
  ): Promise<AsyncIterable<Response>> {
    const candidates = await this.client.findByCapability(this.capability);
    if (candidates.length === 0) {
      throw new AafpError(
        AafpErrorCode.NoAgentsFound,
        `no agents found for capability '${this.capability}'`,
      );
    }

    // Try candidates until one opens a stream successfully
    let lastError: Error | null = null;
    for (const peer of candidates) {
      const addr = peer.endpoints[0];
      if (!addr) continue;
      try {
        const conn = await this.pool.getOrConnect(addr);
        return await this.client.callStreamingOnConnection(
          conn,
          request,
          this.capability,
          opts,
        );
      } catch (e) {
        lastError = e as Error;
        this.pool.remove(addr);
        continue;
      }
    }
    throw lastError ?? new AafpError(
      AafpErrorCode.DiscoveryFailed,
      "all candidates failed to open stream",
    );
  }
}
```

### 4.2 DirectCallBuilder — call by agent ID

```typescript
/**
 * Builder for calling a specific agent by its AgentId (v2).
 * Looks up the agent's record in the DHT, then calls it directly.
 * Uses the connection pool for reuse.
 */
export class DirectCallBuilder {
  constructor(
    private readonly client: AafpClient,
    private readonly pool: ConnectionPool,
    private readonly agentId: AgentId,
  ) {}

  /** Call the specific agent identified by agentId. */
  async call(request: Request, opts?: CallOptions): Promise<Response> {
    const record = await this.client.findByAgentId(this.agentId);
    if (!record) {
      throw new AafpError(
        AafpErrorCode.NoAgentsFound,
        `agent ${this.agentId} not found in DHT`,
      );
    }
    const addr = record.endpoints[0];
    if (!addr) {
      throw new AafpError(
        AafpErrorCode.NoAgentsFound,
        `agent ${this.agentId} has no endpoints`,
      );
    }
    const conn = await this.pool.getOrConnect(addr);
    try {
      const response = await this.client.callOnConnection(
        conn,
        request,
        record.capabilities[0] ?? "call",
        opts,
      );
      this.pool.release(addr);
      return response;
    } catch (e) {
      this.pool.remove(addr);
      throw e;
    }
  }
}
```

### 4.3 Requirements

- Failover in `DiscoveryBuilder.call()` MUST try every candidate before
  throwing. The thrown error is the **last** error encountered (not the first),
  so the caller sees the most recent failure reason.
- On failure, the dead connection MUST be removed from the pool via
  `pool.remove(addr)` so subsequent calls don't reuse it.
- `callStreaming()` opens the stream on the first reachable candidate. Once
  the `AsyncIterable` is returned, failover stops — errors in the stream
  propagate to the `for await` consumer.
- `CallOptions.signal` (AbortSignal) MUST be threaded through to the transport
  layer. If the signal aborts mid-RPC, the bidi stream is closed and the
  promise rejects with an `AbortError`.

---

## 5. ConnectionPool

**File:** `src/pool.ts`

The `ConnectionPool` is the core performance feature of v2. It reuses QUIC
connections across RPC calls, turning a 709µs handshake into a 14µs stream
open — a 50x improvement for repeated calls to the same agent.

### 5.1 PoolConfig

```typescript
// src/pool.ts

import { Multiaddr, AgentKeypair, AgentId } from "./types.ts";
import { Connection, Transport } from "./transport/interface.ts";
import { HandshakeDriver } from "./handshake.ts";

/**
 * Configuration for the connection pool.
 * Mirrors Rust's PoolConfig (connection_pool.rs) with TS-idiomatic naming.
 */
export interface PoolConfig {
  /** Maximum number of cached connections. Default: 32. */
  maxSize: number;
  /** Idle timeout in ms — connections unused for this long are evicted. Default: 60_000. */
  idleTimeoutMs: number;
  /**
   * Health check threshold in ms — connections idle longer than this are
   * health-checked (via a lightweight bidi stream open) before reuse.
   * Default: 5_000. Set to 0 to disable health checks.
   */
  healthCheckThresholdMs: number;
}

export namespace PoolConfig {
  /** Sensible defaults for typical deployments. */
  export function default(): PoolConfig {
    return { maxSize: 32, idleTimeoutMs: 60_000, healthCheckThresholdMs: 5_000 };
  }

  /** High-throughput: more connections, shorter idle timeout. */
  export function highThroughput(): PoolConfig {
    return { maxSize: 256, idleTimeoutMs: 30_000, healthCheckThresholdMs: 5_000 };
  }

  /** Resource-constrained: fewer connections, longer idle timeout. */
  export function conservative(): PoolConfig {
    return { maxSize: 8, idleTimeoutMs: 120_000, healthCheckThresholdMs: 10_000 };
  }
}
```

### 5.2 PooledConnection

```typescript
/**
 * A connection held in the pool, with metadata for eviction and health.
 */
class PooledConnection {
  readonly conn: Connection;
  readonly sessionId: Uint8Array;  // 32 bytes, from handshake transcript
  readonly peerAgentId: AgentId;
  lastUsed: number;  // Date.now() timestamp

  constructor(conn: Connection, sessionId: Uint8Array, peerAgentId: AgentId) {
    this.conn = conn;
    this.sessionId = sessionId;
    this.peerAgentId = peerAgentId;
    this.lastUsed = Date.now();
  }

  /** Whether this connection has been idle longer than the health-check threshold. */
  isIdle(thresholdMs: number): boolean {
    return Date.now() - this.lastUsed > thresholdMs;
  }

  /** Whether this connection has exceeded the idle timeout (eligible for eviction). */
  isExpired(idleTimeoutMs: number): boolean {
    return Date.now() - this.lastUsed > idleTimeoutMs;
  }
}
```

### 5.3 ConnectionPool class

```typescript
/**
 * Connection pool for reusing QUIC connections across RPC calls.
 *
 * Session-based routing: same peer address → same connection. This avoids
 * repeated ML-DSA-65 handshakes (709µs → 14µs for subsequent calls).
 *
 * The pool is keyed by multiaddr string. After the first successful
 * handshake, the peer's AgentId and session ID are stored alongside the
 * connection for inspection and session affinity.
 *
 * Eviction policy: LRU (least recently used). When the pool is full and a
 * new connection is needed, the connection with the oldest lastUsed is
 * evicted and closed.
 *
 * Health checks: connections idle longer than healthCheckThresholdMs are
 * probed via a lightweight bidi stream open before reuse. If the probe
 * fails, the connection is removed and a new one is established.
 */
export class ConnectionPool {
  private readonly connections: Map<string, PooledConnection> = new Map();
  private readonly config: PoolConfig;
  private readonly transport: Transport;
  private readonly keypair: AgentKeypair;

  // Counters for PoolStats
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private healthChecks = 0;
  private healthCheckFailures = 0;

  constructor(config: PoolConfig, transport: Transport, keypair: AgentKeypair) {
    this.config = config;
    this.transport = transport;
    this.keypair = keypair;
  }

  /**
   * Get an existing healthy connection from the pool, or establish a new one.
   * This is the primary entry point used by DiscoveryBuilder and DirectCallBuilder.
   */
  async getOrConnect(addr: Multiaddr): Promise<Connection> {
    // Evict expired connections on every access (cheap scan)
    this.evictExpired();

    const existing = this.connections.get(addr);
    if (existing) {
      // Health check if idle for too long
      if (existing.isIdle(this.config.healthCheckThresholdMs)) {
        this.healthChecks++;
        if (await this.isHealthy(existing.conn)) {
          existing.lastUsed = Date.now();
          this.hits++;
          return existing.conn;
        } else {
          // Health check failed — remove and reconnect
          this.healthCheckFailures++;
          this.connections.delete(addr);
          await existing.conn.close().catch(() => {});
        }
      } else {
        // Recently used — skip health check (assumed healthy)
        existing.lastUsed = Date.now();
        this.hits++;
        return existing.conn;
      }
    }

    // Miss — dial and handshake a new connection
    this.misses++;
    const { conn, sessionId, peerAgentId } = await this.dialAndHandshake(addr);

    // Enforce max size via LRU eviction
    if (this.connections.size >= this.config.maxSize) {
      this.evictLRU();
    }

    this.connections.set(addr, new PooledConnection(conn, sessionId, peerAgentId));
    return conn;
  }

  /** Mark a connection as recently used (called after a successful RPC). */
  release(addr: Multiaddr): void {
    const pc = this.connections.get(addr);
    if (pc) {
      pc.lastUsed = Date.now();
    }
  }

  /** Remove and close a connection (called on RPC failure). */
  async remove(addr: Multiaddr): Promise<void> {
    const pc = this.connections.get(addr);
    if (pc) {
      this.connections.delete(addr);
      await pc.conn.close().catch(() => {});
    }
  }

  /** Close all pooled connections. Idempotent. */
  async closeAll(): Promise<void> {
    const entries = [...this.connections.values()];
    this.connections.clear();
    await Promise.allSettled(entries.map((pc) => pc.conn.close()));
  }

  // ─── Health check ─────────────────────────────────────────────

  /**
   * Health check: open a bidi stream and immediately close it.
   * If the connection is dead, openBidi() will reject.
   */
  private async isHealthy(conn: Connection): Promise<boolean> {
    try {
      const stream = await conn.openBidi();
      stream.finish();  // Immediately close the send side
      return true;
    } catch {
      return false;
    }
  }

  // ─── Eviction ─────────────────────────────────────────────────

  /** Evict all connections that have exceeded the idle timeout. */
  private evictExpired(): void {
    const now = Date.now();
    for (const [addr, pc] of this.connections) {
      if (now - pc.lastUsed > this.config.idleTimeoutMs) {
        this.connections.delete(addr);
        this.evictions++;
        pc.conn.close().catch(() => {});
      }
    }
  }

  /** Evict the least recently used connection (called when pool is full). */
  private evictLRU(): void {
    let oldestAddr: string | null = null;
    let oldestTime = Infinity;
    for (const [addr, pc] of this.connections) {
      if (pc.lastUsed < oldestTime) {
        oldestTime = pc.lastUsed;
        oldestAddr = addr;
      }
    }
    if (oldestAddr) {
      const pc = this.connections.get(oldestAddr);
      this.connections.delete(oldestAddr);
      this.evictions++;
      pc?.conn.close().catch(() => {});
    }
  }

  // ─── Dial + Handshake ─────────────────────────────────────────

  /**
   * Dial a new QUIC connection and run the v1 handshake.
   * Returns the connection, the derived session ID, and the peer's AgentId.
   */
  private async dialAndHandshake(addr: Multiaddr): Promise<{
    conn: Connection;
    sessionId: Uint8Array;
    peerAgentId: AgentId;
  }> {
    const conn = await this.transport.dial(addr);

    // Run the client-side handshake on stream 0
    const controlStream = await conn.openBidi();
    const driver = new HandshakeDriver(this.keypair, "client");
    const result = await driver.runClientHandshake(controlStream);

    return {
      conn,
      sessionId: result.sessionId,
      peerAgentId: result.peerAgentId,
    };
  }

  // ─── Inspection ───────────────────────────────────────────────

  /** Pool statistics snapshot for monitoring. See §6 for PoolStats. */
  get stats(): PoolStats {
    const now = Date.now();
    let active = 0;
    let idle = 0;
    const peers: PoolPeerInfo[] = [];

    for (const [addr, pc] of this.connections) {
      const idleMs = now - pc.lastUsed;
      if (idleMs < this.config.healthCheckThresholdMs) active++;
      else idle++;

      peers.push({
        addr,
        agentId: pc.peerAgentId,
        sessionIdHex: toHex(pc.sessionId),
        lastUsedMs: idleMs,
        state: idleMs < this.config.healthCheckThresholdMs ? "active" : "idle",
      });
    }

    return {
      total: this.connections.size,
      active,
      idle,
      maxSize: this.config.maxSize,
      idleTimeoutMs: this.config.idleTimeoutMs,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      healthChecks: this.healthChecks,
      healthCheckFailures: this.healthCheckFailures,
      hitRate: this.hits + this.misses > 0
        ? this.hits / (this.hits + this.misses)
        : 0,
      peers,
    };
  }

  /** The pool configuration (read-only). */
  get config(): Readonly<PoolConfig> {
    return this.config;
  }
}
```

### 5.4 Requirements

- `getOrConnect()` MUST be safe to call concurrently. Two concurrent calls
  for the same address MAY create two connections (the second will be stored,
  evicting the first via LRU). A future optimization can use a pending-promises
  map to deduplicate, but it's not required for Phase 4.
- Health checks use `conn.openBidi()` + immediate `finish()` — a no-op stream
  that verifies the QUIC connection is alive. This mirrors the Rust
  implementation (`connection_pool.rs:332-347`).
- LRU eviction scans the map for the oldest `lastUsed`. With `maxSize=32` this
  is O(32) — negligible. For `highThroughput()` (256), consider a linked
  hashmap in a future optimization.
- `evictExpired()` runs on every `getOrConnect()` call. This is a cheap O(n)
  scan. An alternative is a `setInterval` timer, but the on-access approach is
  simpler and avoids timer leaks in serverless environments.
- `closeAll()` uses `Promise.allSettled` so one connection's close failure
  doesn't prevent others from closing.

---

## 6. PoolStats Inspection API

**File:** `src/pool.ts` (continued)

```typescript
/** Information about a single pooled connection. */
export interface PoolPeerInfo {
  /** The multiaddr the connection is to. */
  addr: Multiaddr;
  /** The peer's AgentId (hex). */
  agentId: AgentId;
  /** The session ID (hex) derived from the handshake transcript. */
  sessionIdHex: string;
  /** Milliseconds since last use. */
  lastUsedMs: number;
  /** "active" (recently used) or "idle" (past health-check threshold). */
  state: "active" | "idle";
}

/**
 * Snapshot of connection pool state for monitoring and dashboards.
 * Returned by ConnectedAgent.poolStats.
 */
export interface PoolStats {
  /** Total connections currently in the pool. */
  total: number;
  /** Connections used within the health-check threshold (assumed healthy). */
  active: number;
  /** Connections idle past the health-check threshold (will be probed on reuse). */
  idle: number;
  /** Configured maximum pool size. */
  maxSize: number;
  /** Configured idle timeout (ms). */
  idleTimeoutMs: number;

  // ─── Counters (cumulative since pool creation) ────────────────
  /** Pool hits (reused an existing connection). */
  hits: number;
  /** Pool misses (had to dial + handshake a new connection). */
  misses: number;
  /** LRU/expired evictions performed. */
  evictions: number;
  /** Health checks performed. */
  healthChecks: number;
  /** Health checks that failed (connection was dead). */
  healthCheckFailures: number;

  // ─── Derived ──────────────────────────────────────────────────
  /** Hit rate (0..1). hits / (hits + misses). */
  hitRate: number;

  /** Per-connection details. */
  peers: PoolPeerInfo[];
}
```

### 6.1 Usage

```typescript
const agent = await Agent.connect()
  .withPoolConfig(PoolConfig.highThroughput())
  .connect();

// Make some calls...
await agent.discover("echo").call(Request.text("hello"));
await agent.discover("echo").call(Request.text("world"));

// Inspect the pool
const stats = agent.poolStats;
console.log(`Pool: ${stats.active} active, ${stats.idle} idle, ${stats.total}/${stats.maxSize}`);
console.log(`Hit rate: ${(stats.hitRate * 100).toFixed(1)}%`);
console.log(`Evictions: ${stats.evictions}, Health check failures: ${stats.healthCheckFailures}`);

for (const peer of stats.peers) {
  console.log(`  ${peer.agentId} @ ${peer.addr} — ${peer.state}, idle ${peer.lastUsedMs}ms, session ${peer.sessionIdHex.slice(0, 16)}...`);
}
```

---

## 7. HandshakeDriver (Client Side)

**File:** `src/handshake.ts`

The v1 handshake (RFC-0002 §5) is a 3-message exchange:
1. **ClientHello** — client sends its AgentId, ML-DSA-65 public key, a random
   nonce, and supported protocol versions.
2. **ServerHello** — server responds with its AgentId, public key, nonce,
   selected version, and an ML-DSA-65 signature over the transcript so far.
3. **ClientFinished** — client sends its ML-DSA-65 signature over the full
   transcript, completing mutual authentication.

After the handshake, both sides derive a 32-byte **session ID** via HKDF from
the handshake transcript. This session ID is used for session affinity and
is exposed in `PoolStats`.

### 7.1 Design

```typescript
// src/handshake.ts

import { AgentKeypair, AgentId, verifySignature } from "./identity.ts";
import { BidiStream } from "./transport/interface.ts";
import { encodeCbor, decodeCbor, CborValue } from "./cbor.ts";
import { hkdfExtract, hkdfExpand, sha256 } from "./crypto.ts";

export type HandshakeState =
  | "Idle"
  | "ClientHelloSent"
  | "ServerHelloReceived"
  | "Established"
  | "Failed";

export interface HandshakeResult {
  /** The peer's AgentId (hex). */
  peerAgentId: AgentId;
  /** The peer's ML-DSA-65 public key (1952 bytes). */
  peerPublicKey: Uint8Array;
  /** The 32-byte session ID derived from the transcript. */
  sessionId: Uint8Array;
}

const NONCE_SIZE = 32;
const SESSION_ID_SIZE = 32;
const PROTOCOL_VERSION = 1;
const SESSION_ID_INFO = "aafp-session-id-v1";

/**
 * Client-side handshake driver for the AAFP v1 handshake (RFC-0002 §5).
 *
 * The handshake runs over a bidirectional stream (stream 0) on a freshly
 * dialed QUIC connection. It is transport-agnostic — it only needs a
 * BidiStream to send/receive CBOR messages.
 *
 * State machine:
 *   Idle → ClientHelloSent → ServerHelloReceived → Established
 *   (any state) → Failed (on error)
 */
export class HandshakeDriver {
  private state: HandshakeState = "Idle";
  private transcript: Uint8Array[] = [];
  private clientNonce: Uint8Array;
  private serverNonce: Uint8Array | null = null;
  private hAfterClientHello: Uint8Array | null = null;

  constructor(
    private readonly keypair: AgentKeypair,
    private readonly role: "client" | "server",
  ) {
    this.clientNonce = randomBytes(NONCE_SIZE);
  }

  /**
   * Run the full client-side handshake over a bidi stream.
   * Sends ClientHello, receives ServerHello, sends ClientFinished.
   * Returns the handshake result (peer ID, peer pubkey, session ID).
   */
  async runClientHandshake(stream: BidiStream): Promise<HandshakeResult> {
    // ─── Step 1: Send ClientHello ───────────────────────────────
    const clientHello = this.buildClientHello();
    const clientHelloBytes = encodeCbor(clientHello);
    await stream.send.write(clientHelloBytes);
    this.transcript.push(clientHelloBytes);
    this.hAfterClientHello = sha256(concat(this.transcript));
    this.state = "ClientHelloSent";

    // ─── Step 2: Receive ServerHello ────────────────────────────
    const serverHelloRaw = await stream.recv.read();
    if (!serverHelloRaw) throw new HandshakeError("no ServerHello received");
    this.transcript.push(serverHelloRaw);
    const serverHello = decodeCbor(serverHelloRaw);
    const serverHelloMap = expectIntMap(serverHello);

    const peerAgentId = expectText(serverHelloMap.get(1));
    const peerPublicKey = expectBytes(serverHelloMap.get(2));
    this.serverNonce = expectBytes(serverHelloMap.get(3));
    const serverVersion = expectUnsigned(serverHelloMap.get(4));
    const serverSig = expectBytes(serverHelloMap.get(5));

    if (serverVersion !== PROTOCOL_VERSION) {
      throw new HandshakeError(`unsupported protocol version: ${serverVersion}`);
    }

    // Verify server's signature over the transcript (excluding the signature itself)
    const transcriptForServerSig = concat(this.transcript.slice(0, -1));
    if (!verifySignature(serverSig, transcriptForServerSig, peerPublicKey)) {
      throw new HandshakeError("server signature verification failed");
    }

    this.state = "ServerHelloReceived";

    // ─── Step 3: Send ClientFinished ────────────────────────────
    const transcriptForClientSig = concat(this.transcript);
    const clientSig = this.keypair.sign(transcriptForClientSig);
    const clientFinished = new Map<number, CborValue>([
      [1, { type: "bytes", value: clientSig }],
    ]);
    const clientFinishedBytes = encodeCbor(clientFinished);
    await stream.send.write(clientFinishedBytes);
    this.transcript.push(clientFinishedBytes);
    stream.send.finish();

    // ─── Derive session ID ──────────────────────────────────────
    const sessionId = this.deriveSessionId();

    this.state = "Established";
    return { peerAgentId, peerPublicKey, sessionId };
  }

  /** Build the ClientHello CBOR message. */
  private buildClientHello(): Map<number, CborValue> {
    return new Map<number, CborValue>([
      [1, { type: "text", value: this.keypair.agentId() }],          // agent_id
      [2, { type: "bytes", value: this.keypair.publicKey }],         // public_key
      [3, { type: "bytes", value: this.clientNonce }],               // client_nonce
      [4, { type: "unsigned", value: PROTOCOL_VERSION }],            // version
    ]);
  }

  /**
   * Derive the 32-byte session ID from the handshake transcript.
   *
   * Algorithm (mirrors aafp-crypto/src/handshake_v1.rs:343-362):
   *   ikm = h_after_client_hello || server_agent_id
   *   prk = HKDF-Extract(salt = client_nonce || server_nonce, IKM = ikm)
   *   session_id = HKDF-Expand(prk, info = "aafp-session-id-v1", L = 32)
   *
   * Key properties:
   * - 32 bytes, cryptographically derived from the full transcript.
   * - Bound to the server's AgentId (prevents session fixation).
   * - Unique per handshake (nonces are random).
   */
  private deriveSessionId(): Uint8Array {
    if (!this.hAfterClientHello || !this.serverNonce) {
      throw new HandshakeError("cannot derive session ID before handshake completes");
    }

    const serverAgentIdBytes = hexToBytes(this.peerAgentIdForDerivation());
    const ikm = concat([this.hAfterClientHello, serverAgentIdBytes]);
    const salt = concat([this.clientNonce, this.serverNonce]);
    const prk = hkdfExtract(salt, ikm);
    return hkdfExpand(prk, SESSION_ID_INFO, SESSION_ID_SIZE);
  }

  private peerAgentIdForDerivation(): string {
    // In a full implementation, this is set from the ServerHello.
    // Stored as a field during runClientHandshake.
    return this._peerAgentId ?? "";
  }
  private _peerAgentId: string | null = null;

  get established(): boolean {
    return this.state === "Established";
  }

  get currentState(): HandshakeState {
    return this.state;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

export class HandshakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandshakeError";
  }
}

function expectIntMap(v: CborValue | undefined): Map<number, CborValue> {
  if (v?.type !== "int-map") throw new HandshakeError("expected CBOR IntMap");
  return v.entries;
}
function expectText(v: CborValue | undefined): string {
  if (v?.type !== "text") throw new HandshakeError("expected CBOR text");
  return v.value;
}
function expectBytes(v: CborValue | undefined): Uint8Array {
  if (v?.type !== "bytes") throw new HandshakeError("expected CBOR bytes");
  return v.value;
}
function expectUnsigned(v: CborValue | undefined): number {
  if (v?.type !== "unsigned") throw new HandshakeError("expected CBOR unsigned");
  return v.value;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}
```

### 7.2 Session ID Derivation — HKDF

The session ID derivation is the cryptographic heart of session affinity. It
MUST match the Rust implementation (`aafp-crypto/src/handshake_v1.rs:343-362`)
byte-for-byte, because the session ID is used by both sides for affinity
routing and (future) server-side session state.

```
ikm  = h_after_client_hello (32 bytes, SHA-256) || server_agent_id (32 bytes)
salt = client_nonce (32 bytes) || server_nonce (32 bytes)
prk  = HKDF-Extract(salt, ikm)        // HMAC-SHA256 based
sid  = HKDF-Expand(prk, "aafp-session-id-v1", 32)
```

**Implementation notes:**
- `hkdfExtract` and `hkdfExpand` use HMAC-SHA256. Use `@noble/hashes/hkdf` or
  Web Crypto's `SubtleCrypto.deriveBits` with the HKDF algorithm.
- `h_after_client_hello` is SHA-256 of the ClientHello CBOR bytes. This is
  computed after sending ClientHello and before receiving ServerHello.
- The domain separator `"aafp-session-id-v1"` prevents cross-protocol reuse if
  HKDF is used elsewhere with the same inputs.
- The session ID is **not** sent on the wire — both sides derive it
  independently from the transcript. It's stored in `PooledConnection` and
  exposed via `PoolStats.peers[].sessionIdHex`.

### 7.3 Requirements

- The handshake runs on **stream 0** (the first bidi stream opened on the
  connection). After the handshake completes, stream 0 is closed (via
  `send.finish()`), and subsequent RPCs open new bidi streams.
- The handshake MUST enforce the state machine: `Idle → ClientHelloSent →
  ServerHelloReceived → Established`. Any out-of-order message transitions to
  `Failed`.
- Signature verification: the server's signature in ServerHello is verified
  against the transcript **up to but not including** the ServerHello message.
  The client's signature in ClientFinished is over the **full** transcript
  including ServerHello but excluding ClientFinished itself.
- Timeout: the handshake SHOULD have a configurable timeout (default 10s). If
  the peer doesn't respond within the timeout, transition to `Failed` and
  close the stream. This prevents hanging on dead peers.

---

## 8. AafpClient (Internal Engine)

**File:** `src/client.ts`

The `AafpClient` is the internal engine that `ConnectedAgent` wraps. It
handles DHT lookups, RPC encoding/decoding, and the actual stream-level I/O.
It is not part of the public API — users interact via `ConnectedAgent`,
`DiscoveryBuilder`, and `DirectCallBuilder`.

### 8.1 Key methods

```typescript
// src/client.ts (sketch — full implementation in Phase 4)

export class AafpClient {
  constructor(opts: {
    transport: Transport;
    keypair: AgentKeypair;
    seeds: string[];
    pool: ConnectionPool;
  }) {}

  /** Bootstrap into the DHT via seed nodes. */
  async bootstrap(): Promise<void> { /* ... */ }

  /** Find agents providing a capability (DHT lookup). */
  async findByCapability(cap: string): Promise<AgentRecord[]> { /* ... */ }

  /** Find a specific agent by ID (DHT lookup). */
  async findByAgentId(id: AgentId): Promise<AgentRecord | null> { /* ... */ }

  /** Call an agent on an existing (pooled) connection. */
  async callOnConnection(
    conn: Connection,
    request: Request,
    capability: string,
    opts?: CallOptions,
  ): Promise<Response> { /* ... */ }

  /** Start a server-streaming call on an existing connection. */
  async callStreamingOnConnection(
    conn: Connection,
    request: Request,
    capability: string,
    opts?: CallOptions,
  ): Promise<AsyncIterable<Response>> { /* ... */ }

  /** Call an agent at a specific address (uses pool). */
  async callAt(addr: Multiaddr, request: Request): Promise<Response> { /* ... */ }

  /** Register an agent record in the local DHT cache. */
  register(record: AgentRecord): void { /* ... */ }

  /** Shut down the client. */
  async close(): Promise<void> { /* ... */ }
}
```

### 8.2 RPC encoding

`callOnConnection` encodes the request as an AAFP RPC frame:
1. Open a bidi stream: `const stream = await conn.openBidi()`.
2. Build `RpcRequest` with `id` (incrementing counter), `method` = capability
   name, and `params` from `request.params.toCbor()` (or TextString fallback
   for v1 compat).
3. Encode as CBOR, wrap in a `Frame` (28-byte header + payload), write to
   `stream.send`.
4. Call `stream.send.finish()` (half-close for unary).
5. Read the response frame from `stream.recv`, decode `RpcResponse`, convert
   to `Response`.
6. If `opts.signal` aborts, close the stream and reject with `AbortError`.

---

## 9. File Layout

```
src/
  types.ts            (Phase 1 — shared v2 types)
  identity.ts         (Phase 1 — AgentKeypair, ML-DSA-65)
  cbor.ts             (Phase 1 — CBOR encoder/decoder)
  crypto.ts           (Phase 1 — SHA-256, HKDF, HMAC)
  transport/
    interface.ts      (Phase 2 — Transport, BidiStream, Connection)
    node-quic.ts      (Phase 2 — node:quic binding)
    webtransport.ts   (Phase 2 — WebTransport binding)
  serve.ts            (Phase 3 — ServeBuilder, ServingAgent)
  server.ts           (Phase 3 — AafpServer, accept loop)
  ├── connect.ts      (Phase 4 — ConnectBuilder, ConnectedAgent)     ← NEW
  ├── discovery.ts    (Phase 4 — DiscoveryBuilder, DirectCallBuilder) ← NEW
  ├── pool.ts         (Phase 4 — ConnectionPool, PoolConfig, PoolStats) ← NEW
  ├── handshake.ts    (Phase 4 — HandshakeDriver, session ID derivation) ← NEW
  └── client.ts       (Phase 4 — AafpClient internal engine)          ← NEW
```

---

## 10. Implementation Steps

### Step 1: HandshakeDriver (client side)
- Implement `src/handshake.ts` with the full v1 state machine.
- Implement `deriveSessionId()` using `@noble/hashes/hkdf` or Web Crypto.
- Write unit tests with golden transcript vectors (generated from the Rust
  implementation — compare session IDs byte-for-byte).
- Test: handshake against a Rust server (integration test).

### Step 2: ConnectionPool
- Implement `src/pool.ts` with `PoolConfig`, `PooledConnection`,
  `ConnectionPool`.
- Implement `getOrConnect()`, `release()`, `remove()`, `closeAll()`.
- Implement health checks (`isHealthy` via `openBidi` + `finish`).
- Implement LRU eviction (`evictLRU`) and expired eviction (`evictExpired`).
- Implement `PoolStats` with all counters and per-peer info.
- Write unit tests: pool reuse, eviction, health check failure, concurrent
  access.

### Step 3: AafpClient
- Implement `src/client.ts` with DHT lookup, RPC encode/decode, streaming.
- Implement `callOnConnection()` and `callStreamingOnConnection()`.
- Implement `AbortSignal` support for cancellation.
- Write integration tests against a running `AafpServer` (from Phase 3).

### Step 4: ConnectBuilder + ConnectedAgent
- Implement `src/connect.ts` with `ConnectBuilder` and `ConnectedAgent`.
- Wire up `discover()`, `discoverById()`, `callAt()`, `register()`,
  `poolStats`, `close()`.
- Write end-to-end tests: connect, discover, call, pool reuse, failover.

### Step 5: DiscoveryBuilder + DirectCallBuilder
- Implement `src/discovery.ts` with failover loop and streaming.
- Test failover: register 3 agents for "echo", kill the first, verify the call
  succeeds via the second.
- Test `discoverById`: direct call by agent ID.
- Test `callStreaming`: consume an async iterable of responses.

### Step 6: Integration test suite
- Full round-trip: `ServeBuilder` (Phase 3) → `ConnectBuilder` (Phase 4) →
  discover → call → verify response.
- Pool stats verification: make 10 calls to the same agent, verify `hitRate`
  approaches 0.9 (1 miss + 9 hits).
- Concurrency: 100 concurrent calls, verify no deadlocks or pool corruption.
- Golden-trace conformance: compare handshake transcripts and session IDs
  with the Rust implementation.

---

## 11. Acceptance Criteria

1. **`Agent.connect().connect()`** produces a `ConnectedAgent` with a working
   `ConnectionPool`.

2. **`agent.discover("echo").call(Request.text("hello"))`** returns the
   correct response, with failover across multiple candidates.

3. **`agent.discoverById(id).call(Request.text("hello"))`** calls the specific
   agent by ID.

4. **Connection reuse**: the second call to the same agent reuses the pooled
   connection (verified via `poolStats.hits > 0` and no new handshake).

5. **Failover**: if the first candidate is unreachable, the call succeeds via
   the next candidate without throwing.

6. **PoolStats**: `agent.poolStats` returns a snapshot with `total`, `active`,
   `idle`, `hits`, `misses`, `hitRate`, `evictions`, `peers[]`.

7. **LRU eviction**: when the pool is full, the oldest connection is evicted
   (verified by filling the pool and checking `evictions` counter).

8. **Health check**: an idle connection is probed before reuse; a dead
   connection is removed and replaced (verified by killing a server and
   checking `healthCheckFailures`).

9. **Session ID**: the derived session ID matches the Rust implementation
   byte-for-byte for the same handshake transcript (golden-trace test).

10. **Cancellation**: `AbortController.abort()` cancels an in-flight RPC and
    the promise rejects with `AbortError`.

11. **Streaming**: `callStreaming()` returns an `AsyncIterable<Response>` that
    yields chunks via `for await`.

12. **`using await agent = ...`** (explicit resource management) closes the
    pool and client on scope exit.

---

## 12. Performance Targets

Based on the Rust implementation (Apple M4, release build):

| Metric | Rust | TS Target | Notes |
|--------|------|-----------|-------|
| Full handshake (dial + ML-DSA-65) | 709µs | ~5–20ms | JS crypto is 10–50x slower |
| Stream open on pooled connection | 1.34µs | ~50–100µs | QUIC stream creation in JS |
| Pool hit rate (repeated calls) | >99% | >99% | Same algorithm |
| 100 RPCs to same agent (pooled) | 0.39µs/RPC | ~100µs/RPC | JS overhead per RPC |

The TS SDK will be slower than Rust due to pure-JS ML-DSA-65, but the **pool
speedup ratio** (50x for repeated calls) should be preserved — the handshake
cost is amortized the same way.

---

## 13. Dependencies

- `@noble/post-quantum` — ML-DSA-65 sign/verify (already in Phase 1).
- `@noble/hashes` — SHA-256, HKDF, HMAC-SHA256 (already in Phase 1).
- Web Crypto API (`crypto.getRandomValues`) — for nonce generation.
- No new dependencies for Phase 4.

---

## 14. References

- `TYPESCRIPT_SDK_DESIGN.md` §5.4–§5.6, §7.4
- `SESSION_AFFINITY_DESIGN.md` §1–§5, §8.3
- `SIMPLE_API_V2_DESIGN.md` §4, §9
- `RFC-0002` §5 (handshake), §6 (framing)
- `RFC-0003` (identity — ML-DSA-65)
- `RFC-0005` §6 (error codes)
- Rust: `crates/aafp-sdk/src/connection_pool.rs`
- Rust: `crates/aafp-crypto/src/handshake_v1.rs:343-362` (session ID derivation)
- Rust: `crates/aafp-sdk/src/handshake_driver.rs:216-321` (client handshake)
