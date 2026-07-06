/**
 * Public API entry point for the AAFP TypeScript SDK server-side API.
 *
 * Re-exports all public types, classes, interfaces, and enums from the
 * server-side modules.
 *
 * @module index
 */

// ─── types.ts ───────────────────────────────────────────────────
export type { CborValue, RequestMetadata, ResponseMetadata } from "./types.js";
export { Params, Request, Response } from "./types.js";

// ─── handler.ts ─────────────────────────────────────────────────
export {
  HandlerContext,
  HandlerError,
  HandlerErrorCategory,
  StreamingHandlerContext,
} from "./handler.js";
export type {
  CapabilityHandler,
  StreamingHandler,
  BidirectionalHandler,
  LegacyHandler,
} from "./handler.js";

// ─── serve.ts ───────────────────────────────────────────────────
export { ServeBuilder, ServingAgent } from "./serve.js";
export type {
  ServeOptions,
  AgentId,
  Multiaddr,
  AgentRecord,
  TransportFactory,
  Transport,
  Connection,
  BidiStream,
  PoolConfig,
} from "./serve.js";

// ─── handshake.ts ───────────────────────────────────────────────
export { HandshakeDriver } from "./handshake.js";
export type {
  ServerHandshakeState,
  AgentKeypair,
  BidiStream as HandshakeBidiStream,
  Frame,
} from "./handshake.js";

// ─── session.ts ─────────────────────────────────────────────────
export { SessionStateMachine } from "./session.js";
export type { SessionState } from "./session.js";

// ─── metrics.ts ─────────────────────────────────────────────────
export { AgentMetrics, PrometheusExporter, HealthStatus } from "./metrics.js";
export type { MetricsSnapshot } from "./metrics.js";

// ─── pool.ts (Phase 4 — client-side connection pool) ───────────
export { ConnectionPool, PoolStatsBuilder } from "./pool.js";
export type {
  PooledConnection,
  PoolPeerInfo,
  PoolStats,
} from "./pool.js";
// NOTE: PoolConfig is also exported from ./serve.js as a placeholder.
// The real PoolConfig (with presets: default, highThroughput, conservative)
// lives in ./pool.js. The serve.js placeholder export should be replaced
// in a future cleanup to avoid the name conflict.

// ─── client-handshake.ts (Phase 4 — client-side handshake) ──────
export {
  HandshakeError,
  HandshakeDriver as ClientHandshakeDriver,
  deriveSessionId,
} from "./client-handshake.js";
export type {
  HandshakeState as ClientHandshakeState,
  HandshakeResult,
  SessionIdParams,
} from "./client-handshake.js";
// NOTE: HandshakeDriver is also exported from ./handshake.js (server-side).
// The client-side driver is exported here as ClientHandshakeDriver to
// avoid the name conflict. The two will be unified in a future cleanup.

// ─── discovery.ts (Phase 4 — discovery + direct call) ───────────
export { DiscoveryBuilder, DirectCallBuilder, failoverLoop } from "./discovery.js";
export type {
  CallOptions,
  FailoverStep,
  FailoverLoopConfig,
} from "./discovery.js";

// ─── connect.ts (Phase 4 — client connection API) ───────────────
export { ConnectBuilder, ConnectedAgent } from "./connect.js";
export type { ConnectOptions } from "./connect.js";
